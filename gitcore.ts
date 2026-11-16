// gitcore.ts -- the git object model this forge runs on, plus its packfile codec.
//
// Objects are content-addressed by SHA-1 over "<type> <length>\0<bytes>", held in
// one in-memory map. Trees, commits and tags are parsed lazily and the parses are
// cached beside the raw bytes; flattened file listings of trees are cached too,
// because merges and diffs ask for them again and again over the same trees.
//
// The pack reader resolves OFS/REF deltas and reports every object's id as it
// goes, so a receive never has to hash the same bytes twice. Inflating a pack
// entry is a single zlib pass that asks the engine how many input bytes it ate,
// instead of probing prefix lengths until one inflates.
//
// Only node:crypto and node:zlib are used: the trial pod has no git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** An object together with the id it hashes to. */
export interface KnownObject extends GitObject {
  oid: string;
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
// the store

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();
  private readonly parsedCommits = new Map<string, ParsedCommit>();
  private readonly parsedTrees = new Map<string, TreeEntry[]>();
  private readonly flatListings = new Map<string, Map<string, string>>();

  /** Hash `data` and keep it under its id (a no-op when already present). */
  add(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Keep an object whose id the caller already knows (a received pack entry). */
  put(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** The parsed commit at `oid`, or null when it is not a commit we hold. */
  commit(oid: string): ParsedCommit | null {
    let parsed = this.parsedCommits.get(oid);
    if (parsed === undefined) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return null;
      parsed = parseCommit(object.data);
      this.parsedCommits.set(oid, parsed);
    }
    return parsed;
  }

  /** The parsed entries of the tree at `oid`, or null when it is not a tree. */
  tree(oid: string): TreeEntry[] | null {
    let parsed = this.parsedTrees.get(oid);
    if (parsed === undefined) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return null;
      parsed = parseTree(object.data);
      this.parsedTrees.set(oid, parsed);
    }
    return parsed;
  }

  /**
   * Every file under the tree at `treeOid`, as path -> blob oid (gitlinks are
   * skipped: they name a commit of some other repository). The map is cached
   * and shared, so callers must treat it as read-only.
   */
  flattenTree(treeOid: string): Map<string, string> {
    let flat = this.flatListings.get(treeOid);
    if (flat !== undefined) return flat;
    flat = new Map<string, string>();
    const descend = (oid: string, prefix: string): void => {
      const entries = this.tree(oid);
      if (entries === null) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') descend(entry.oid, path);
        else if (entry.mode !== '160000') flat.set(path, entry.oid);
      }
    };
    descend(treeOid, '');
    this.flatListings.set(treeOid, flat);
    return flat;
  }
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  /** The mode exactly as it sits in the tree object, e.g. "100644", "40000". */
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(at, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

/** Git orders tree entries by name, directories as if the name ended in "/". */
function treeOrderKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const ordered = [...entries].sort((a, b) => {
    const ka = treeOrderKey(a);
    const kb = treeOrderKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const chunks: Buffer[] = [];
  for (const entry of ordered) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// commits and tags

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  /** Committer timestamp, in seconds. */
  timestamp: number;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const parsed: ParsedCommit = {
    tree: '',
    parents: [],
    author: '',
    committer: '',
    timestamp: 0,
    message: split >= 0 ? text.slice(split + 2) : '',
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) parsed.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parsed.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) parsed.author = line.slice(7);
    else if (line.startsWith('committer ')) {
      parsed.committer = line.slice(10);
      const stamp = / (\d+) [+-]\d{4}$/.exec(parsed.committer);
      if (stamp !== null) parsed.timestamp = Number(stamp[1]);
    }
  }
  return parsed;
}

export interface CommitSpec {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}

export function buildCommit(spec: CommitSpec): Buffer {
  const lines = [`tree ${spec.tree}`];
  for (const parent of spec.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${spec.author}`, `committer ${spec.committer}`, '', spec.message);
  return Buffer.from(lines.join('\n'), 'utf8');
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
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const parsed: ParsedTag = {
    object: '',
    type: '',
    tag: '',
    tagger: '',
    message: split >= 0 ? text.slice(split + 2) : '',
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) parsed.object = line.slice(7).trim();
    else if (line.startsWith('type ')) parsed.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) parsed.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) parsed.tagger = line.slice(7);
  }
  return parsed;
}

/** Follow tag objects until a commit turns up (or something else stops us). */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hop = 0; hop < 16; hop += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** One peel: a tag's target, or the oid itself for anything else. */
export function peelOne(store: ObjectStore, oid: string): string {
  const object = store.get(oid);
  return object !== undefined && object.type === 'tag' ? parseTag(object.data).object : oid;
}

// ---------------------------------------------------------------------------
// reachability

/** Add a tree and everything beneath it to `into`. */
export function addTreeClosure(store: ObjectStore, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const entries = store.tree(treeOid);
  if (entries === null) return;
  into.add(treeOid);
  for (const entry of entries) {
    if (entry.mode === '40000') addTreeClosure(store, entry.oid, into);
    else if (entry.mode !== '160000') into.add(entry.oid);
  }
}

/** Every object reachable from `tip`: history, trees, blobs and tag targets. */
export function reachableFrom(store: ObjectStore, tip: string, into: Set<string> = new Set()): Set<string> {
  const pending = [tip];
  while (pending.length > 0) {
    const oid = pending.pop()!;
    if (into.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'commit') {
      const commit = store.commit(oid);
      if (commit !== null) {
        addTreeClosure(store, commit.tree, into);
        for (const parent of commit.parents) pending.push(parent);
      }
    } else if (object.type === 'tag') {
      pending.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      addTreeClosure(store, oid, into);
    }
  }
  return into;
}

/** All commits reachable from `tip`, `tip` itself included. */
export function commitAncestors(store: ObjectStore, tip: string): Set<string> {
  const out = new Set<string>();
  const pending = [tip];
  while (pending.length > 0) {
    const oid = pending.pop()!;
    if (out.has(oid)) continue;
    const commit = store.commit(oid);
    if (commit === null) continue;
    out.add(oid);
    for (const parent of commit.parents) pending.push(parent);
  }
  return out;
}

/**
 * Whether `ancestor` is `descendant` or one of its ancestors. The walk stops
 * the moment the ancestor turns up: a push that extends a branch by one commit
 * (the common case, and the benchmark's) is answered at the first parent
 * instead of by collecting the branch's whole history into a set.
 */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const pending = [descendant];
  while (pending.length > 0) {
    const oid = pending.pop()!;
    const commit = store.commit(oid);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        pending.push(parent);
      }
    }
  }
  return false;
}

/**
 * The best common ancestor of two commits. The histories this forge sees are
 * near-linear, so: check the two tips against each other's ancestry, then walk
 * `b` generation by generation and take the first commit that is an ancestor
 * of `a`.
 */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = commitAncestors(store, a);
  if (ancestorsOfA.has(b)) return b;
  if (isAncestor(store, a, b)) return a;
  const seen = new Set<string>([b]);
  let frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (ancestorsOfA.has(oid)) return oid;
      const commit = store.commit(oid);
      if (commit !== null) {
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
// pkt-lines

export type PktLine = string | 'flush' | 'delim' | 'response-end';

export function encodePktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function encodePktLines(lines: readonly PktLine[]): Buffer {
  const chunks: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') chunks.push(Buffer.from('0000', 'ascii'));
    else if (line === 'delim') chunks.push(Buffer.from('0001', 'ascii'));
    else if (line === 'response-end') chunks.push(Buffer.from('0002', 'ascii'));
    else chunks.push(encodePktLine(line));
  }
  return Buffer.concat(chunks);
}

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a whole pkt-line stream; throws on malformed framing. */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let at = 0;
  while (at < buffer.length) {
    if (at + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      at += 4;
    } else if (length === 3) {
      packets.push({ kind: 'data', payload: Buffer.alloc(0) });
      at += 4;
    } else {
      if (length < 4 || at + length > buffer.length) throw new Error('pkt-line overruns the buffer');
      packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(at + 4, at + length)) });
      at += length;
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

/**
 * A version-2 pack of plain (never delta) entries with a SHA-1 trailer. The
 * zlib level leans toward speed: a pack is read once by its receiver, and the
 * streams stay small either way.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const object of objects) {
    // The entry header: the type in bits 4-6 of the first byte, then the size
    // in 4 low bits and 7-bit little-endian groups while bytes remain.
    const head: number[] = [];
    let rest = object.data.length;
    const low = rest & 0x0f;
    rest >>= 4;
    if (rest === 0) {
      head.push((TYPE_IDS[object.type] << 4) | low);
    } else {
      head.push(((TYPE_IDS[object.type] << 4) | low) | 0x80);
      while (rest > 0) {
        const group = rest & 0x7f;
        rest >>= 7;
        head.push(rest > 0 ? group | 0x80 : group);
      }
    }
    chunks.push(Buffer.from(head));
    chunks.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate the zlib stream that starts at `offset` and report how many input
 * bytes it consumed. Asking the engine for its byte count makes this one pass;
 * guessing prefix lengths would inflate the same bytes a dozen times over.
 * Should an engine ever not report its byte count, fall back to probing
 * prefixes (a doubling search, then a binary one) for the shortest length
 * that inflates -- slower, but the same answer.
 */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  if (offset >= buffer.length) throw new Error('inflate past the end of the pack');
  try {
    const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine?: { bytesWritten?: number };
    };
    const consumed = result.engine?.bytesWritten;
    if (typeof consumed === 'number' && consumed > 0) {
      return { data: result.buffer, consumed };
    }
  } catch {
    // Not a readable stream here; the probe below reaches the same verdict.
  }
  const max = buffer.length - offset;
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

/** Run a git delta program (copy/insert opcodes) over `base`. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new Error('delta varint overruns');
      const byte = delta[at]!;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const opcode = delta[at]!;
    at += 1;
    if ((opcode & 0x80) !== 0) {
      let copyAt = 0;
      let copySize = 0;
      if (opcode & 0x01) copyAt |= delta[at++]!;
      if (opcode & 0x02) copyAt |= delta[at++]! << 8;
      if (opcode & 0x04) copyAt |= delta[at++]! << 16;
      if (opcode & 0x08) copyAt |= delta[at++]! << 24;
      if (opcode & 0x10) copySize |= delta[at++]!;
      if (opcode & 0x20) copySize |= delta[at++]! << 8;
      if (opcode & 0x40) copySize |= delta[at++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      chunks.push(base.subarray(copyAt, copyAt + copySize));
      produced += copySize;
    } else if (opcode > 0) {
      chunks.push(delta.subarray(at, at + opcode));
      produced += opcode;
      at += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(chunks);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackReadResult {
  objects: KnownObject[];
  deltaCount: number;
}

/**
 * Parse a packfile end to end, resolving deltas against entries in the same
 * pack or, for a thin pack, against `resolveBase`. Every returned object
 * carries the id it hashes to, computed once during resolution. Throws on any
 * structural problem.
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
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!pack.subarray(pack.length - 20).equals(digest)) throw new Error('pack checksum mismatch');
  const end = pack.length - 20;

  interface RawEntry {
    kind: GitObjectType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    start: number;
    baseOffset: number;
    baseOid: string;
  }
  const raw: RawEntry[] = [];
  const indexByOffset = new Map<number, number>();
  const indexByOid = new Map<string, number>();
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const start = at;
    if (at >= end) throw new Error('pack entry overruns');
    let byte = pack[at]!;
    at += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[at]!;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const kind = TYPE_NAMES[typeId];
    if (kind === undefined) throw new Error(`pack entry type ${typeId} unknown`);
    const entry: RawEntry = { kind, data: Buffer.alloc(0), start, baseOffset: -1, baseOid: '' };
    if (kind === 'ofs-delta') {
      let backByte = pack[at]!;
      at += 1;
      let back = backByte & 0x7f;
      while ((backByte & 0x80) !== 0) {
        backByte = pack[at]!;
        at += 1;
        back = ((back + 1) << 7) | (backByte & 0x7f);
      }
      entry.baseOffset = start - back;
    } else if (kind === 'ref-delta') {
      entry.baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    }
    const inflated = inflateAt(pack, at);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    at += inflated.consumed;
    indexByOffset.set(start, raw.length);
    raw.push(entry);
  }
  if (at !== end) throw new Error('pack has trailing bytes before the trailer');

  // Plain entries are identified up front: a REF delta may name any of them as
  // its base, including one that sits later in the pack than the delta itself.
  const resolved: Array<KnownObject | null> = raw.map(() => null);
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index]!;
    if (entry.kind !== 'ofs-delta' && entry.kind !== 'ref-delta') {
      const object: KnownObject = { oid: hashObject(entry.kind, entry.data), type: entry.kind, data: entry.data };
      resolved[index] = object;
      indexByOid.set(object.oid, index);
    }
  }
  const resolve = (index: number): KnownObject => {
    const done = resolved[index];
    if (done !== null) return done;
    const entry = raw[index]!;
    let object: KnownObject;
    if (entry.kind === 'ofs-delta') {
      const baseIndex = indexByOffset.get(entry.baseOffset);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseIndex);
      const data = applyDelta(base.data, entry.data);
      object = { oid: hashObject(base.type, data), type: base.type, data };
    } else if (entry.kind === 'ref-delta') {
      let base: GitObject | undefined;
      const baseIndex = indexByOid.get(entry.baseOid);
      if (baseIndex !== undefined) base = resolve(baseIndex);
      if (base === undefined) base = resolveBase?.(entry.baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} unavailable`);
      const data = applyDelta(base.data, entry.data);
      object = { oid: hashObject(base.type, data), type: base.type, data };
    } else {
      // Plain entries were all resolved in the pass above.
      throw new Error('unreachable: plain entry left unresolved');
    }
    resolved[index] = object;
    return object;
  };

  const objects: KnownObject[] = [];
  let deltaCount = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index]!.kind === 'ofs-delta' || raw[index]!.kind === 'ref-delta') deltaCount += 1;
    objects.push(resolve(index));
  }
  return { objects, deltaCount };
}
