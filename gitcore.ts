// Pure-JS git object model: SHA-1 ids, loose-object store (in memory), tree/commit/tag
// parsing and serialising, packfile read (with OFS/REF delta application) and packfile
// write (plain, non-delta entries — a valid pack everywhere), and the pkt-line codec.
// Only node:crypto and node:zlib are used; there is no git binary in the trial pod.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// the object store

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();
  private readonly commitCache = new Map<string, ParsedCommit>();
  private readonly treeCache = new Map<string, TreeEntry[]>();

  add(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (from a received pack). */
  put(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  commit(oid: string): ParsedCommit | null {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  tree(oid: string): TreeEntry[] | null {
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'tree') return null;
    const parsed = parseTree(object.data);
    this.treeCache.set(oid, parsed);
    return parsed;
  }
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  /** The mode exactly as stored, e.g. "100644" or "40000" for a directory. */
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// commits and tags

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  /** Committer timestamp, seconds. */
  timestamp: number;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) {
      committer = line.slice(10);
      const match = / (\d+) [+-]\d{4}$/.exec(committer);
      if (match) timestamp = Number(match[1]);
    }
  }
  return { tree, parents, author, committer, timestamp, message };
}

export interface CommitSpec {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}

export function buildCommit(spec: CommitSpec): Buffer {
  let text = `tree ${spec.tree}\n`;
  for (const parent of spec.parents) text += `parent ${parent}\n`;
  text += `author ${spec.author}\ncommitter ${spec.committer}\n\n${spec.message}`;
  return Buffer.from(text, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank >= 0 ? text.slice(0, blank) : text;
  const out: ParsedTag = { object: '', type: '', tag: '', tagger: '', message: blank >= 0 ? text.slice(blank + 2) : '' };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

/** The commit a (possibly annotated) tag ultimately points at, or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The object a tag points at (one level), or the oid itself for non-tags. */
export function peelOne(store: ObjectStore, oid: string): string {
  const object = store.get(oid);
  if (object && object.type === 'tag') return parseTag(object.data).object;
  return oid;
}

// ---------------------------------------------------------------------------
// reachability

/** Add a tree and everything under it to `into`. */
export function addTreeClosure(store: ObjectStore, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const entries = store.tree(treeOid);
  if (!entries) return;
  into.add(treeOid);
  for (const entry of entries) {
    if (entry.mode === '40000') addTreeClosure(store, entry.oid, into);
    else if (entry.mode !== '160000') into.add(entry.oid);
  }
}

/** Every object reachable from `tip` (commit history, trees, blobs, tag targets). */
export function reachableFrom(store: ObjectStore, tip: string, into: Set<string> = new Set()): Set<string> {
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    into.add(oid);
    if (object.type === 'commit') {
      const commit = store.commit(oid);
      if (commit) {
        addTreeClosure(store, commit.tree, into);
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      addTreeClosure(store, oid, into);
    }
  }
  return into;
}

/** All commit ancestors of `tip`, including `tip` itself. */
export function commitAncestors(store: ObjectStore, tip: string): Set<string> {
  const out = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const commit = store.commit(oid);
    if (!commit) continue;
    out.add(oid);
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(store, descendant).has(ancestor);
}

/**
 * The best common ancestor of two commits: the common ancestor that is not itself an
 * ancestor of another common ancestor. Histories here are near-linear, so the first
 * common commit met walking back from `b` (newest first) is the merge base.
 */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = commitAncestors(store, a);
  if (ancestorsOfA.has(b)) return b;
  if (commitAncestors(store, b).has(a)) return a;
  // Walk b's history breadth-first by generation so the newest common commit wins.
  let frontier = [b];
  const seen = new Set<string>(frontier);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (ancestorsOfA.has(oid)) return oid;
      const commit = store.commit(oid);
      if (commit) {
        for (const parent of commit.parents) {
          if (!seen.has(parent)) {
            seen.add(parent);
            next.push(parent);
          }
        }
      }
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// pkt-line codec

export type PktLine = string | 'flush' | 'delim' | 'response-end';

export function encodePktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function encodePktLines(lines: readonly PktLine[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (line === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else if (line === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a complete pkt-line stream; throws on malformed framing. */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 3) {
      packets.push({ kind: 'data', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the buffer');
      packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + length)) });
      offset += length;
    }
  }
  return packets;
}

// ---------------------------------------------------------------------------
// packfiles

const TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_NAMES: Record<number, GitObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

/** Write a version-2 pack of plain (non-delta) objects with a SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const typeId = TYPE_IDS[object.type];
    const bytes: number[] = [];
    let first = true;
    // varint: low 4 bits then 7 bits at a time, little-endian groups
    let value = size;
    let low = value & 0x0f;
    value >>= 4;
    while (value > 0) {
      bytes.push((first ? (typeId << 4) | low : low) | 0x80);
      low = value & 0x7f;
      value >>= 7;
      first = false;
    }
    bytes.push(first ? (typeId << 4) | low : low);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate the zlib stream starting at `offset`, finding its exact length.
 * inflateSync ignores trailing bytes after the stream's end, so the consumed
 * length is the shortest prefix that inflates without throwing (any shorter
 * prefix is missing the stream's final block and throws).
 */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  const max = buffer.length - offset;
  if (max <= 0) throw new Error('inflate past the end of the pack');
  const attempt = (length: number): Buffer | null => {
    try {
      return inflateSync(buffer.subarray(offset, offset + length));
    } catch {
      return null;
    }
  };
  let hi = 1;
  let data = attempt(hi);
  while (data === null && hi < max) {
    hi = Math.min(max, hi * 2);
    data = attempt(hi);
  }
  if (data === null) throw new Error('corrupt zlib stream in pack');
  // Binary search for the shortest working prefix in (hi/2, hi].
  let lo = Math.floor(hi / 2);
  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (attempt(mid) !== null) hi = mid;
    else lo = mid;
  }
  const exact = attempt(hi);
  if (exact === null) throw new Error('corrupt zlib stream in pack');
  return { data: exact, consumed: hi };
}

/** Apply a git delta (copy/insert program) to `base`. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint overruns');
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset]!;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (opcode & 0x01) copyOffset |= delta[offset++]!;
      if (opcode & 0x02) copyOffset |= delta[offset++]! << 8;
      if (opcode & 0x04) copyOffset |= delta[offset++]! << 16;
      if (opcode & 0x08) copyOffset |= delta[offset++]! << 24;
      if (opcode & 0x10) copySize |= delta[offset++]!;
      if (opcode & 0x20) copySize |= delta[offset++]! << 8;
      if (opcode & 0x40) copySize |= delta[offset++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode > 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackReadResult {
  objects: GitObject[];
  deltaCount: number;
}

/**
 * Parse a packfile fully, resolving deltas against objects in the same pack or, for a
 * thin pack, against `resolveBase`. Throws on any structural problem.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): PackReadResult {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} unsupported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  const end = pack.length - 20;
  let offset = 12;
  interface RawEntry {
    type: GitObjectType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    start: number;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    if (offset >= end) throw new Error('pack entry overruns');
    let byte = pack[offset]!;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = TYPE_NAMES[typeId];
    if (type === undefined) throw new Error(`pack entry type ${typeId} unknown`);
    const entry: RawEntry = { type, data: Buffer.alloc(0), start };
    if (type === 'ofs-delta') {
      let byteAt = pack[offset]!;
      offset += 1;
      let back = byteAt & 0x7f;
      while (byteAt & 0x80) {
        byteAt = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (byteAt & 0x7f);
      }
      entry.baseOffset = start - back;
    } else if (type === 'ref-delta') {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset += inflated.consumed;
    byOffset.set(start, raw.length);
    raw.push(entry);
  }
  if (offset !== end) throw new Error('pack has trailing bytes before the trailer');
  const resolved: Array<GitObject | null> = raw.map(() => null);
  const resolvedOids: Array<string | null> = raw.map(() => null);
  const resolve = (index: number): GitObject => {
    const done = resolved[index];
    if (done) return done;
    const entry = raw[index]!;
    let object: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseIndex = byOffset.get(entry.baseOffset!);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseIndex);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      for (let candidate = 0; candidate < raw.length; candidate += 1) {
        if (raw[candidate]!.type === 'ofs-delta' || raw[candidate]!.type === 'ref-delta') continue;
        const candidateObject = resolve(candidate);
        if (resolvedOids[candidate] === entry.baseOid) {
          base = candidateObject;
          break;
        }
      }
      if (!base) base = resolveBase?.(entry.baseOid!);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} unavailable`);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    resolved[index] = object;
    resolvedOids[index] = hashObject(object.type, object.data);
    return object;
  };
  const objects: GitObject[] = [];
  let deltaCount = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index]!.type === 'ofs-delta' || raw[index]!.type === 'ref-delta') deltaCount += 1;
    objects.push(resolve(index));
  }
  return { objects, deltaCount };
}
