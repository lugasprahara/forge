// gitcore.ts -- the git object database: content-addressed blobs, trees,
// commits and tags in one memory map, with the derived views the rest of the
// forge keeps asking for (parsed commits, parsed trees, flattened listings)
// cached next to the raw bytes.
//
// Two design choices are about speed, because the benchmark drives this
// store hard:
//   * an object is hashed exactly once, when it enters the store; every
//     later reader works from the id it already knows;
//   * the deflated pack entry of an object is cached the first time a pack
//     includes it, so serving the same history to fifty clones deflates
//     each distinct object once, not once per clone.
//
// Only node:crypto and node:zlib are touched: the trial pod has no git
// binary, so the object model is implemented here from the format up.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const EMPTY_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

export interface AddressedObject extends StoredObject {
  oid: string;
}

/** SHA-1 over the git framing "<type> <length>\0" followed by the bytes. */
export function objectId(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function looksLikeOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

// ---------------------------------------------------------------------------
// the store itself

const PACK_ENTRY_CACHE_LIMIT = 60_000;

export class ObjectStore {
  private readonly byId = new Map<string, StoredObject>();
  private readonly commitCache = new Map<string, CommitInfo>();
  private readonly treeCache = new Map<string, TreeItem[]>();
  private readonly flatCache = new Map<string, Map<string, string>>();
  private readonly entryCache = new Map<string, Buffer>();

  /**
   * How many objects have ever been added. Readers that memoize answers
   * derived from the store include this in their key: any addition moves
   * it, so a memoized answer can never outlive the store it described.
   */
  additions = 0;

  /** Insert bytes under the id they hash to; returns the id. */
  add(type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.byId.has(oid)) {
      this.byId.set(oid, { type, data });
      this.additions += 1;
    }
    return oid;
  }

  /** Insert an object whose id the caller computed while unpacking. */
  putKnown(oid: string, type: ObjectType, data: Buffer): void {
    if (!this.byId.has(oid)) {
      this.byId.set(oid, { type, data });
      this.additions += 1;
    }
  }

  get(oid: string): StoredObject | undefined {
    return this.byId.get(oid);
  }

  has(oid: string): boolean {
    return this.byId.has(oid);
  }

  /** The parsed commit at `oid`, or null when no such commit is held. */
  commit(oid: string): CommitInfo | null {
    let info = this.commitCache.get(oid);
    if (info === undefined) {
      const object = this.byId.get(oid);
      if (object === undefined || object.type !== 'commit') return null;
      info = readCommit(object.data);
      this.commitCache.set(oid, info);
    }
    return info;
  }

  /** The entries of the tree at `oid`, or null when no such tree is held. */
  tree(oid: string): TreeItem[] | null {
    let items = this.treeCache.get(oid);
    if (items === undefined) {
      const object = this.byId.get(oid);
      if (object === undefined || object.type !== 'tree') return null;
      items = readTree(object.data);
      this.treeCache.set(oid, items);
    }
    return items;
  }

  /**
   * path -> blob oid for every file under a tree (gitlinks excluded: they
   * name foreign commits). Cached and shared; callers must not mutate it.
   */
  flatten(treeOid: string): Map<string, string> {
    let flat = this.flatCache.get(treeOid);
    if (flat !== undefined) return flat;
    flat = new Map<string, string>();
    const walk = (oid: string, prefix: string): void => {
      const items = this.tree(oid);
      if (items === null) return;
      for (const item of items) {
        const path = prefix === '' ? item.name : `${prefix}/${item.name}`;
        if (item.mode === '40000') walk(item.oid, path);
        else if (item.mode !== '160000') flat.set(path, item.oid);
      }
    };
    walk(treeOid, '');
    this.flatCache.set(treeOid, flat);
    return flat;
  }

  /**
   * The packfile entry bytes (varint header + deflated body) for an object,
   * computed on first use and then reused by every pack that serves it.
   */
  packEntry(oid: string, object: StoredObject): Buffer {
    let entry = this.entryCache.get(oid);
    if (entry === undefined) {
      entry = encodePackEntry(object.type, object.data);
      if (this.entryCache.size >= PACK_ENTRY_CACHE_LIMIT) this.entryCache.clear();
      this.entryCache.set(oid, entry);
    }
    return entry;
  }
}

// ---------------------------------------------------------------------------
// trees

export interface TreeItem {
  /** The mode exactly as written in the tree object ("100644", "40000", ...). */
  mode: string;
  name: string;
  oid: string;
}

export function readTree(data: Buffer): TreeItem[] {
  const items: TreeItem[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    items.push({
      mode: data.toString('ascii', at, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return items;
}

/** Git sorts tree entries by name, directories as if suffixed with "/". */
function sortKey(item: TreeItem): string {
  return item.mode === '40000' ? `${item.name}/` : item.name;
}

export function writeTree(items: readonly TreeItem[]): Buffer {
  const ordered = [...items].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const item of ordered) {
    parts.push(Buffer.from(`${item.mode} ${item.name}\0`, 'utf8'));
    parts.push(Buffer.from(item.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  /** Committer time, seconds since the epoch. */
  when: number;
  message: string;
}

export function readCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const info: CommitInfo = {
    tree: '',
    parents: [],
    author: '',
    committer: '',
    when: 0,
    message: split >= 0 ? text.slice(split + 2) : '',
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) {
      info.committer = line.slice(10);
      const stamp = / (\d+) [+-]\d{4}$/.exec(info.committer);
      if (stamp !== null) info.when = Number(stamp[1]);
    }
  }
  return info;
}

export interface CommitDraft {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}

export function writeCommit(draft: CommitDraft): Buffer {
  const lines = [`tree ${draft.tree}`];
  for (const parent of draft.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${draft.author}`, `committer ${draft.committer}`, '', draft.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function readTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const info: TagInfo = {
    object: '',
    type: '',
    tag: '',
    tagger: '',
    message: split >= 0 ? text.slice(split + 2) : '',
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Follow a chain of tag objects down to the commit it names, if any. */
export function peelCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hop = 0; hop < 16; hop += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = readTag(object.data).object;
  }
  return null;
}

/** One peel step: a tag's target, or the oid itself for anything else. */
export function peelOnce(store: ObjectStore, oid: string): string {
  const object = store.get(oid);
  return object !== undefined && object.type === 'tag' ? readTag(object.data).object : oid;
}

// ---------------------------------------------------------------------------
// reachability and ancestry

/** Add a tree and everything under it to `into`. */
export function addTreeContents(store: ObjectStore, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const items = store.tree(treeOid);
  if (items === null) return;
  into.add(treeOid);
  for (const item of items) {
    if (item.mode === '40000') addTreeContents(store, item.oid, into);
    else if (item.mode !== '160000') into.add(item.oid);
  }
}

/** Every object reachable from `tip`, history and contents alike. */
export function collectReachable(store: ObjectStore, tip: string, into: Set<string> = new Set()): Set<string> {
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
        addTreeContents(store, commit.tree, into);
        for (const parent of commit.parents) pending.push(parent);
      }
    } else if (object.type === 'tag') {
      pending.push(readTag(object.data).object);
    } else if (object.type === 'tree') {
      addTreeContents(store, oid, into);
    }
  }
  return into;
}

/** All commits reachable from `tip`, including `tip`. */
export function ancestorSet(store: ObjectStore, tip: string): Set<string> {
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
 * Whether `older` is `newer` itself or one of its ancestors. The walk stops
 * at the first sighting: the common push extends a branch by one commit, and
 * its answer is the new commit's parent list, not the branch's history.
 */
export function isAncestorOf(store: ObjectStore, older: string, newer: string): boolean {
  if (older === newer) return true;
  const seen = new Set<string>([newer]);
  const pending = [newer];
  while (pending.length > 0) {
    const oid = pending.pop()!;
    const commit = store.commit(oid);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === older) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        pending.push(parent);
      }
    }
  }
  return false;
}

/**
 * The best common ancestor of two commits. Histories here are near-linear,
 * so after the two direct checks the walk goes generation by generation
 * from `b` and takes the first commit that is an ancestor of `a`.
 */
export function commonAncestor(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(store, a);
  if (ancestorsOfA.has(b)) return b;
  if (isAncestorOf(store, a, b)) return a;
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
// pack entry encoding (the writer half of the pack codec lives here because
// the store caches the encoded form; the reader half is pack.ts)

const TYPE_NUMBERS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/**
 * One pack entry: the type/size varint followed by the object deflated at
 * the lowest zlib level. A pack is written once and read once; small and
 * fast beats marginally smaller.
 */
export function encodePackEntry(type: ObjectType, data: Buffer): Buffer {
  const head: number[] = [];
  let rest = data.length;
  const low = rest & 0x0f;
  rest >>= 4;
  if (rest === 0) {
    head.push((TYPE_NUMBERS[type] << 4) | low);
  } else {
    head.push(((TYPE_NUMBERS[type] << 4) | low) | 0x80);
    while (rest > 0) {
      const group = rest & 0x7f;
      rest >>= 7;
      head.push(rest > 0 ? group | 0x80 : group);
    }
  }
  return Buffer.concat([Buffer.from(head), deflateSync(data, { level: 1 })]);
}

// pack.ts -- the packfile reader and the pkt-line framing.
//
// Writing a pack is mostly assembly: the store caches each object's encoded
// entry (objects.ts), so a pack is a header, the concatenation of entries
// it may already have built for an earlier fetch, and a SHA-1 trailer.
//
// Reading is the careful direction. A received pack is verified against its
// trailer, each entry is inflated in a single pass that asks zlib how many
// input bytes it consumed, and OFS/REF deltas are resolved against entries
// of the same pack (or, for a thin pack, against the store). Every object
// comes out with the id it hashes to, computed once, during resolution.


// ---------------------------------------------------------------------------
// pkt-lines

export type PktControl = 'flush' | 'delim' | 'response-end';
export type PktLine = string | PktControl;

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktLines(lines: readonly PktLine[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (line === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else if (line === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a whole pkt-line stream; throws on malformed framing. */
export function readPktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let at = 0;
  while (at < buffer.length) {
    if (at + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.toString('ascii', at, at + 4);
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
// writing

/** A version-2 pack holding `objects`, plain entries only, SHA-1 trailer. */
export function buildPack(store: ObjectStore, entries: ReadonlyArray<{ oid: string; object: StoredObject }>): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  for (const entry of entries) parts.push(store.packEntry(entry.oid, entry.object));
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// reading

/**
 * Inflate the zlib stream beginning at `offset`; returns the bytes and how
 * many input bytes the stream occupied. One pass: the engine reports its
 * own consumption. Should an engine ever withhold it, fall back to a
 * doubling-then-binary search for the shortest prefix that inflates.
 */
function inflateEntry(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  if (offset >= buffer.length) throw new Error('inflate past the end of the pack');
  try {
    const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine?: { bytesWritten?: number };
    };
    const consumed = result.engine?.bytesWritten;
    if (typeof consumed === 'number' && consumed > 0) return { data: result.buffer, consumed };
  } catch {
    // Not a readable stream at this offset; the probe reaches the same verdict.
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
  const parts: Buffer[] = [];
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
      parts.push(base.subarray(copyAt, copyAt + copySize));
      produced += copySize;
    } else if (opcode > 0) {
      parts.push(delta.subarray(at, at + opcode));
      produced += opcode;
      at += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

const KIND_BY_ID: Record<number, ObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

export interface PackContents {
  objects: AddressedObject[];
  deltaCount: number;
}

/**
 * Parse a packfile end to end. Plain entries are identified first (a REF
 * delta may name a base that sits later in the pack than the delta), then
 * deltas resolve recursively. Throws on any structural problem, including
 * a trailer that does not match the bytes.
 */
export function parsePack(
  pack: Buffer,
  baseLookup?: (oid: string) => StoredObject | undefined,
): PackContents {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} unsupported`);
  const count = pack.readUInt32BE(8);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!pack.subarray(pack.length - 20).equals(digest)) throw new Error('pack checksum mismatch');
  const end = pack.length - 20;

  interface RawEntry {
    kind: ObjectType | 'ofs-delta' | 'ref-delta';
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
    const kind = KIND_BY_ID[typeId];
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
      entry.baseOid = pack.toString('hex', at, at + 20);
      at += 20;
    }
    const inflated = inflateEntry(pack, at);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    at += inflated.consumed;
    indexByOffset.set(start, raw.length);
    raw.push(entry);
  }
  if (at !== end) throw new Error('pack has trailing bytes before the trailer');

  const resolved: Array<AddressedObject | null> = raw.map(() => null);
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index]!;
    if (entry.kind !== 'ofs-delta' && entry.kind !== 'ref-delta') {
      const object: AddressedObject = { oid: objectId(entry.kind, entry.data), type: entry.kind, data: entry.data };
      resolved[index] = object;
      indexByOid.set(object.oid, index);
    }
  }
  const resolve = (index: number): AddressedObject => {
    const done = resolved[index];
    if (done !== null) return done;
    const entry = raw[index]!;
    let object: AddressedObject;
    if (entry.kind === 'ofs-delta') {
      const baseIndex = indexByOffset.get(entry.baseOffset);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseIndex);
      const data = applyDelta(base.data, entry.data);
      object = { oid: objectId(base.type, data), type: base.type, data };
    } else if (entry.kind === 'ref-delta') {
      let base: StoredObject | undefined;
      const baseIndex = indexByOid.get(entry.baseOid);
      if (baseIndex !== undefined) base = resolve(baseIndex);
      if (base === undefined) base = baseLookup?.(entry.baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} unavailable`);
      const data = applyDelta(base.data, entry.data);
      object = { oid: objectId(base.type, data), type: base.type, data };
    } else {
      throw new Error('unreachable: plain entry left unresolved');
    }
    resolved[index] = object;
    return object;
  };

  const objects: AddressedObject[] = [];
  let deltaCount = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index]!.kind === 'ofs-delta' || raw[index]!.kind === 'ref-delta') deltaCount += 1;
    objects.push(resolve(index));
  }
  return { objects, deltaCount };
}
