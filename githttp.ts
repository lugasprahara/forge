// Git smart HTTP: ref advertisement (protocol v0 and v2), ls-refs, fetch with
// want/have negotiation and shallow support, and receive-pack with report-status.
// Implemented from the wire format; packs we send are plain (non-delta), packs we
// receive are fully parsed including deltas (see gitcore.ts).

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

function peeledOf(forge: Forge, oid: string): string | null {
  const object = forge.store.get(oid);
  if (!object || object.type !== 'tag') return null;
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
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`);
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
// pkt-line stream helpers for protocol v2 sections

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65_000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

/** Assemble v2 response sections: header line + lines, delim between, flush at end. */
function v2Response(sections: Array<{ header: string; lines: string[] }>, pack: Buffer | null): Buffer {
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    parts.push(encodePktLine(section.header));
    for (const line of section.lines) parts.push(encodePktLine(line));
    if (index < sections.length - 1 || pack !== null) parts.push(encodePktLines(['delim']));
  });
  if (pack !== null) {
    parts.push(encodePktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
  }
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
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
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (args.symrefs) line += ` symref-target:${headRef}`;
      lines.push(`${line}\n`);
    } else if (args.unborn) {
      let line = 'unborn HEAD';
      if (args.symrefs) line += ` symref-target:${headRef}`;
      lines.push(`${line}\n`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
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

function planFetch(forge: Forge, repo: Repo, request: FetchRequest): FetchPlan {
  const store = forge.store;
  const shallowClientSet = new Set(request.shallowClient);
  const excluded = new Set<string>();
  const common: string[] = [];
  for (const have of request.haves) {
    const commit = peelToCommit(store, have);
    if (commit !== null && store.has(commit)) common.push(commit);
    if (shallowClientSet.has(have)) {
      // The client holds this commit and its tree, but not its parents.
      excluded.add(have);
      const parsed = store.commit(have);
      if (parsed) addTreeClosure(store, parsed.tree, excluded);
    } else {
      reachableFrom(store, have, excluded);
    }
  }
  for (const not of request.deepenNot) reachableFrom(store, not, excluded);

  // Breadth-first walk from the wants, generation by generation.
  const included = new Set<string>();
  const extraObjects = new Set<string>();
  const distance = new Map<string, number>();
  let frontier: string[] = [];
  for (const want of request.wants) {
    if (!store.has(want)) continue;
    const object = store.get(want)!;
    if (object.type === 'commit') {
      if (!distance.has(want)) {
        distance.set(want, 0);
        frontier.push(want);
      }
    } else {
      // Tags (and stray trees/blobs) ride along whole.
      reachableFrom(store, want, extraObjects);
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
        // A shallow-held commit: do not resend it, but its parents are in play.
        if (shallowClientSet.has(oid)) {
          const commit = store.commit(oid);
          if (commit) {
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
      if (!commit) continue;
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

  const sendSet = new Set<string>();
  for (const oid of included) {
    sendSet.add(oid);
    const commit = store.commit(oid);
    if (commit) addTreeClosure(store, commit.tree, sendSet);
  }
  for (const oid of extraObjects) sendSet.add(oid);
  for (const oid of excluded) sendSet.delete(oid);

  // Shallow bookkeeping: boundary = an included commit with a parent left behind.
  const shallow: string[] = [];
  if (depth !== null || request.deepenSince !== null) {
    for (const oid of included) {
      const commit = store.commit(oid);
      if (!commit) continue;
      if (commit.parents.some((parent) => !included.has(parent) && !excluded.has(parent))) shallow.push(oid);
      else if (commit.parents.some((parent) => shallowClientSet.has(parent))) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of shallowClientSet) {
    if (shallow.includes(oid)) continue;
    const commit = store.commit(oid);
    if (!commit) continue;
    if (commit.parents.every((parent) => included.has(parent) || excluded.has(parent))) unshallow.push(oid);
  }

  const send = [...sendSet].filter((oid) => store.has(oid));
  return { send, shallow: shallow.sort(), unshallow: unshallow.sort(), common };
}

function packFor(forge: Forge, oids: string[]): Buffer {
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = forge.store.get(oid);
    if (object) objects.push(object);
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
  if (command === '') return null;
  return { command, args, request };
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
  const firstText = packets.length > 0 && packets[0]!.kind === 'data' ? packets[0]!.payload.toString('utf8') : '';

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
        const lines = [
          ...plan.shallow.map((oid) => `shallow ${oid}\n`),
          ...plan.unshallow.map((oid) => `unshallow ${oid}\n`),
        ];
        sections.push({ header: 'shallow-info\n', lines });
      }
      const pack = plan.send.length > 0 ? packFor(forge, plan.send) : null;
      const out = v2Response(sections, pack);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
      res.end(out);
      return;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`unknown command ${parsed.command}\n`);
    return;
  }

  // Protocol v0: want lines (first carries capabilities), flush, have lines, done, flush.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowClient: string[] = [];
  let depth: number | null = null;
  let section: 'want' | 'have' = 'want';
  let valid = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      if (section === 'want') section = 'have';
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      wants.push(rest.split(' ')[0]!);
      valid = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowClient.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  if (!valid) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad upload-pack request\n');
    return;
  }
  const plan = planFetch(forge, repo, { wants, haves, shallowClient, depth, deepenSince: null, deepenNot: [] });
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.common.length > 0) {
    plan.common.forEach((oid, index) => {
      const last = index === plan.common.length - 1;
      parts.push(encodePktLine(last && plan.send.length > 0 ? `ACK ${oid} ready\n` : `ACK ${oid}\n`));
    });
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  if (plan.send.length > 0) parts.push(...sidebandPackets(packFor(forge, plan.send)));
  parts.push(encodePktLines(['flush']));
  const out = Buffer.concat(parts);
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
  // Split the pkt-line command list from the packfile that follows it.
  let offset = 0;
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let parseOk = true;
  try {
    for (;;) {
      if (offset + 4 > body.length) {
        parseOk = false;
        break;
      }
      const hex = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        parseOk = false;
        break;
      }
      const length = parseInt(hex, 16);
      if (length === 0) {
        offset += 4;
        break;
      }
      if (length < 4 || offset + length > body.length) {
        parseOk = false;
        break;
      }
      let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      offset += length;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') capabilities.add(cap);
        line = line.slice(0, nul);
      }
      const fields = line.split(' ');
      if (fields.length !== 3) {
        parseOk = false;
        break;
      }
      commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
    }
  } catch {
    parseOk = false;
  }
  if (!parseOk || commands.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad receive-pack request\n');
    return;
  }
  const packBytes = body.subarray(offset);
  const wantsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (wantsPack && packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => forge.store.get(oid));
      for (const object of read.objects) forge.store.add(object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
      process.stderr.write(`[entry] unpack failed: ${unpackDetail}\n`);
    }
  } else if (wantsPack && packBytes.length === 0) {
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
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!forge.store.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid object' });
      continue;
    }
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

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat([
    ...reportLines.map((line) => encodePktLine(line)),
    encodePktLines(['flush']),
  ]);
  let out: Buffer;
  if (capabilities.has('side-band-64k')) {
    const chunks: Buffer[] = [];
    const CHUNK = 65_000;
    for (let at = 0; at < report.length; at += CHUNK) {
      chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), report.subarray(at, Math.min(report.length, at + CHUNK))])));
    }
    chunks.push(encodePktLines(['flush']));
    out = Buffer.concat(chunks);
  } else {
    out = report;
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
  res.end(out);
}
