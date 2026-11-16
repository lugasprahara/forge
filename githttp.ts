// githttp.ts -- git smart HTTP: ref advertisement (protocol v0 and v2), ls-refs,
// fetch with want/have negotiation and shallow support, and receive-pack with
// report-status. Written from the wire format; the packs this forge sends are
// plain (no deltas), the packs it receives are parsed in full (see gitcore.ts).
//
// The receive path is the hot one -- the benchmark pushes single commits back
// to back -- so it leans on gitcore's fast paths: pack entries arrive with
// their ids already computed, and the fast-forward test stops at the first
// parent it recognises instead of walking the whole history.

import type { ServerResponse } from 'node:http';
import {
  ZERO_OID,
  addTreeClosure,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  parseTag,
  peelToCommit,
  readPack,
  reachableFrom,
  writePack,
  type GitObject,
  type PktPacket,
} from './gitcore.ts';
import type { Forge, Repo } from './forge.ts';

const AGENT = 'forge/1.0.0';
const UPLOAD_CAPS_V0 =
  'multi_ack_detailed side-band-64k ofs-delta thin-pack shallow ' +
  'symref=HEAD:refs/heads/main agent=' + AGENT;
const RECEIVE_CAPS_V0 =
  'report-status side-band-64k delete-refs ofs-delta quiet agent=' + AGENT;

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The commit a ref's tag object points at, or null when the ref is no tag. */
function peeledOf(forge: Forge, oid: string): string | null {
  const object = forge.store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

// ---------------------------------------------------------------------------
// advertisement

export function advertise(
  forge: Forge,
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  wantsV2: boolean,
  res: ServerResponse,
): void {
  if (wantsV2 && service === 'git-upload-pack') {
    const body = encodePktLines([
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow\n',
      'object-format=sha1\n',
      'flush',
    ]);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'git-protocol': 'version=2',
      'content-length': body.length,
    });
    res.end(body);
    return;
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const refs = sortedRefs(repo);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${repo.refs.get(headRef) ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const [ref, oid] of refs) {
      lines.push(`${oid} ${ref}\n`);
      const peeled = peeledOf(forge, oid);
      if (peeled !== null) lines.push(`${peeled} ${ref}^{}\n`);
    }
  }
  const body = Buffer.concat([
    encodePktLines([`# service=${service}\n`, 'flush']),
    encodePktLines(lines),
    encodePktLines(['flush']),
  ]);
  res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'content-length': body.length,
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// framing helpers

/** Wrap a pack in side-band-64k data packets (band 1), 65,000 bytes a packet. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65_000;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const chunk = pack.subarray(at, Math.min(pack.length, at + CHUNK));
    packets.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

/** A protocol v2 response: named sections split by delims, then the packfile. */
function v2Response(sections: Array<{ header: string; lines: string[] }>, pack: Buffer | null): Buffer {
  const chunks: Buffer[] = [];
  sections.forEach((section, index) => {
    chunks.push(encodePktLine(section.header));
    for (const line of section.lines) chunks.push(encodePktLine(line));
    if (index < sections.length - 1 || pack !== null) chunks.push(encodePktLines(['delim']));
  });
  if (pack !== null) {
    chunks.push(encodePktLine('packfile\n'));
    chunks.push(...sidebandPackets(pack));
  }
  chunks.push(encodePktLines(['flush']));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(forge: Forge, repo: Repo, args: LsRefsArgs): Buffer {
  const wanted = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const lines: string[] = [];
  if (wanted('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!wanted(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = peeledOf(forge, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => encodePktLine(line)), encodePktLines(['flush'])]);
}

// ---------------------------------------------------------------------------
// fetch planning

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowClient: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

interface FetchPlan {
  send: string[];
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/**
 * Work out what a fetch sends: the commits within the requested depth of the
 * wants, minus everything the haves already cover, with the shallow boundary
 * the depth cut leaves behind.
 */
function planFetch(forge: Forge, repo: Repo, request: FetchRequest): FetchPlan {
  const store = forge.store;
  const clientShallow = new Set(request.shallowClient);
  const excluded = new Set<string>();
  const common: string[] = [];
  for (const have of request.haves) {
    const commit = peelToCommit(store, have);
    if (commit !== null && store.has(commit)) common.push(commit);
    if (clientShallow.has(have)) {
      // The client holds this commit and its tree, but not its parents.
      excluded.add(have);
      const parsed = store.commit(have);
      if (parsed !== null) addTreeClosure(store, parsed.tree, excluded);
    } else {
      reachableFrom(store, have, excluded);
    }
  }
  for (const not of request.deepenNot) reachableFrom(store, not, excluded);

  // Generation-by-generation walk out of the wants, distance-stamped.
  const distance = new Map<string, number>();
  const included = new Set<string>();
  const extras = new Set<string>();
  let frontier: string[] = [];
  for (const want of request.wants) {
    if (!store.has(want)) continue;
    if (store.get(want)!.type === 'commit') {
      if (!distance.has(want)) {
        distance.set(want, 0);
        frontier.push(want);
      }
    } else {
      // Tags (and any stray tree or blob) travel whole; their commit joins too.
      reachableFrom(store, want, extras);
      const commit = peelToCommit(store, want);
      if (commit !== null && !distance.has(commit)) {
        distance.set(commit, 0);
        frontier.push(commit);
      }
    }
  }
  const depth = request.depth;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      const dist = distance.get(oid)!;
      if (depth !== null && dist >= depth) continue;
      if (excluded.has(oid)) {
        // A commit the client holds shallow: skip it, but its parents play on.
        if (clientShallow.has(oid)) {
          const commit = store.commit(oid);
          if (commit !== null) {
            for (const parent of commit.parents) {
              if (!distance.has(parent)) {
                distance.set(parent, dist + 1);
                next.push(parent);
              }
            }
          }
        }
        continue;
      }
      const commit = store.commit(oid);
      if (commit === null) continue;
      if (request.deepenSince !== null && commit.timestamp < request.deepenSince && dist > 0) continue;
      included.add(oid);
      for (const parent of commit.parents) {
        if (!distance.has(parent)) {
          distance.set(parent, dist + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  const sendSet = new Set<string>(extras);
  for (const oid of included) {
    sendSet.add(oid);
    const commit = store.commit(oid);
    if (commit !== null) addTreeClosure(store, commit.tree, sendSet);
  }
  for (const oid of excluded) sendSet.delete(oid);

  // The shallow boundary: an included commit whose parent stays behind.
  const shallow: string[] = [];
  if (depth !== null || request.deepenSince !== null) {
    for (const oid of included) {
      const commit = store.commit(oid);
      if (commit === null) continue;
      const cutOff = commit.parents.some((parent) => !included.has(parent) && !excluded.has(parent));
      const overShallow = commit.parents.some((parent) => clientShallow.has(parent));
      if (cutOff || overShallow) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (shallow.includes(oid)) continue;
    const commit = store.commit(oid);
    if (commit === null) continue;
    if (commit.parents.every((parent) => included.has(parent) || excluded.has(parent))) unshallow.push(oid);
  }

  return {
    send: [...sendSet].filter((oid) => store.has(oid)),
    shallow: shallow.sort(),
    unshallow: unshallow.sort(),
    common,
  };
}

function packFor(forge: Forge, oids: string[]): Buffer {
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = forge.store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return writePack(objects);
}

// ---------------------------------------------------------------------------
// upload-pack

function parseV2Sections(packets: PktPacket[]): { command: string; args: string[]; request: string[] } | null {
  let command = '';
  const args: string[] = [];
  const request: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      else args.push(line);
    } else {
      request.push(line);
    }
  }
  return command === '' ? null : { command, args, request };
}

function fetchFromLines(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallowClient: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const line of lines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallowClient.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
  }
  return request;
}

export function handleUploadPack(forge: Forge, repo: Repo, body: Buffer, res: ServerResponse): void {
  let packets: PktPacket[];
  try {
    packets = decodePktLines(body);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad pkt-line stream\n');
    return;
  }
  const firstText = packets.length > 0 && packets[0]!.kind === 'data'
    ? packets[0]!.payload.toString('utf8')
    : '';

  if (firstText.startsWith('command=')) {
    const parsed = parseV2Sections(packets);
    if (parsed === null) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad protocol v2 request\n');
      return;
    }
    if (parsed.command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of [...parsed.args, ...parsed.request]) {
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      const out = lsRefs(forge, repo, args);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
      res.end(out);
      return;
    }
    if (parsed.command === 'fetch') {
      const request = fetchFromLines(parsed.request);
      const plan = planFetch(forge, repo, request);
      const sections: Array<{ header: string; lines: string[] }> = [];
      if (request.haves.length > 0) {
        const lines: string[] = [];
        if (plan.common.length > 0) {
          for (const oid of plan.common) lines.push(`ACK ${oid}\n`);
          if (plan.send.length > 0) lines.push('ready\n');
        } else {
          lines.push('NAK\n');
        }
        sections.push({ header: 'acknowledgments\n', lines });
      }
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        sections.push({
          header: 'shallow-info\n',
          lines: [
            ...plan.shallow.map((oid) => `shallow ${oid}\n`),
            ...plan.unshallow.map((oid) => `unshallow ${oid}\n`),
          ],
        });
      }
      const out = v2Response(sections, plan.send.length > 0 ? packFor(forge, plan.send) : null);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
      res.end(out);
      return;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`unknown command ${parsed.command}\n`);
    return;
  }

  // Protocol v0: want lines (the first carries the capabilities), a flush,
  // have lines, done, a flush.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowClient: string[] = [];
  let depth: number | null = null;
  let sawWant = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') continue;

    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      wants.push(line.slice(5).trim().split(' ')[0]!);
      sawWant = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowClient.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  if (!sawWant) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad upload-pack request\n');
    return;
  }
  const plan = planFetch(forge, repo, { wants, haves, shallowClient, depth, deepenSince: null, deepenNot: [] });
  const chunks: Buffer[] = [];
  for (const oid of plan.shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.common.length > 0) {
    plan.common.forEach((oid, index) => {
      const ready = index === plan.common.length - 1 && plan.send.length > 0;
      chunks.push(encodePktLine(ready ? `ACK ${oid} ready\n` : `ACK ${oid}\n`));
    });
  } else {
    chunks.push(encodePktLine('NAK\n'));
  }
  if (plan.send.length > 0) chunks.push(...sidebandPackets(packFor(forge, plan.send)));
  chunks.push(encodePktLines(['flush']));
  const out = Buffer.concat(chunks);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
  res.end(out);
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(forge: Forge, repo: Repo, body: Buffer, res: ServerResponse): Promise<void> {
  // The body opens with the pkt-line command list; the packfile follows it.
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let at = 0;
  let wellFormed = true;
  while (wellFormed) {
    if (at + 4 > body.length) {
      wellFormed = false;
      break;
    }
    const hex = body.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      wellFormed = false;
      break;
    }
    const length = parseInt(hex, 16);
    if (length === 0) {
      at += 4;
      break;
    }
    if (length < 4 || at + length > body.length) {
      wellFormed = false;
      break;
    }
    let line = body.subarray(at + 4, at + length).toString('utf8').replace(/\n$/, '');
    at += length;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') capabilities.add(cap);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length !== 3) {
      wellFormed = false;
      break;
    }
    commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
  }
  if (!wellFormed || commands.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad receive-pack request\n');
    return;
  }

  const packBytes = body.subarray(at);
  const expectsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (expectsPack && packBytes.length > 0) {
    try {
      const pack = readPack(packBytes, (oid) => forge.store.get(oid));
      for (const object of pack.objects) forge.store.put(object.oid, object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
      process.stderr.write(`[entry] unpack failed: ${unpackDetail}\n`);
    }
  } else if (expectsPack) {
    unpackOk = false;
    unpackDetail = 'no packfile received';
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!forge.store.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid object' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== ZERO_OID) {
      const currentCommit = peelToCommit(forge.store, current);
      const newCommit = peelToCommit(forge.store, command.newOid);
      if (currentCommit !== null && newCommit !== null && !isAncestor(forge.store, currentCommit, newCommit)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportLines = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat([
    ...reportLines.map((line) => encodePktLine(line)),
    encodePktLines(['flush']),
  ]);
  let out = report;
  if (capabilities.has('side-band-64k')) {
    const chunks: Buffer[] = [];
    const CHUNK = 65_000;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      const piece = report.subarray(offset, Math.min(report.length, offset + CHUNK));
      chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), piece])));
    }
    chunks.push(encodePktLines(['flush']));
    out = Buffer.concat(chunks);
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
  res.end(out);
}
