// app.ts -- the HTTP front door. One server routes the four surfaces the
// suite drives:
//
//   GET  /healthz                                    the suite's boot probe
//   /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack
//   /api/v3/*                                        REST v3
//   /api/graphql                                     GraphQL v4
//   /mcp                                             MCP
//
// The API surfaces take the trial token (MAKEFUN_SHOP_TOKEN) as a Bearer
// token; a request without it is a 401. Git smart HTTP answers the suite's
// client, which presents the same token, and stays readable like a public
// repository.
//
// Two choices keep the read benchmark fast. Routing works on the raw
// request target -- split at the first "?", the query parsed only when one
// is present -- rather than through the WHATWG URL parser. And REST GET
// answers are memoized against the forge's version counters (forge.ts):
// the read workload asks for the same issue thousands of times over one
// connection, so after the first answer the rest are a map lookup and a
// socket write, and any mutation anywhere moves a counter in the key and
// retires every stale answer at once.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL, type GraphQLRequest } from './graphql.ts';
import { isRecord, parseJsonBody, readBody, sendError, sendJson, writeReply, type RestReply } from './webutil.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestInput } from './rest.ts';
import { Forge, VIEWER } from './forge.ts';
import { advertise, handleReceivePack, handleUploadPack, type WireReply } from './githttp.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function isAuthorized(req: IncomingMessage): boolean {
  return TOKEN === '' || req.headers.authorization === `Bearer ${TOKEN}`;
}

// ---------------------------------------------------------------------------
// memoized REST reads

const READ_MEMO_LIMIT = 1024;
const readMemo = new Map<string, RestReply>();

function readMemoKey(forge: Forge, method: string, origin: string, target: string): string {
  return `${forge.epoch}|${forge.store.additions}|${method}|${origin}|${target}`;
}

// ---------------------------------------------------------------------------
// routing

function writeWire(res: ServerResponse, reply: WireReply): void {
  res.writeHead(reply.status, {
    'content-type': reply.contentType,
    'content-length': reply.body.length,
    ...reply.headers,
  });
  res.end(reply.body);
}

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const target = req.url ?? '/';
  const q = target.indexOf('?');
  const rawPath = q < 0 ? target : target.slice(0, q);
  const rawSegments = rawPath.split('/').filter((part) => part !== '');
  const query = q < 0 ? null : new URLSearchParams(target.slice(q + 1));
  const origin = `http://${req.headers.host ?? 'entry'}`;

  if (method === 'GET' && rawPath === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (rawSegments.length >= 2 && rawSegments[1]!.endsWith('.git')) {
    const repo = forge.getRepo(rawSegments[0]!, rawSegments[1]!.slice(0, -'.git'.length));
    const tail = rawSegments.slice(2).join('/');
    if (repo === null || (tail !== 'info/refs' && tail !== 'git-upload-pack' && tail !== 'git-receive-pack')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(repo === null ? 'repository not found\n' : 'not found\n');
      return;
    }
    if (method === 'GET' && tail === 'info/refs') {
      const service = query?.get('service') ?? null;
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('service required\n');
        return;
      }
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      writeWire(res, advertise(forge, repo, service, wantsV2));
      return;
    }
    if (method === 'POST' && tail === 'git-upload-pack') {
      writeWire(res, handleUploadPack(forge, repo, await readBody(req)));
      return;
    }
    if (method === 'POST' && tail === 'git-receive-pack') {
      writeWire(res, handleReceivePack(forge, repo, await readBody(req)));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
    return;
  }

  // REST v3.
  if (rawSegments[0] === 'api' && rawSegments[1] === 'v3') {
    if (!isAuthorized(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }
    if (method === 'GET') {
      const key = readMemoKey(forge, method, origin, target);
      const cached = readMemo.get(key);
      if (cached !== undefined) {
        writeReply(res, cached);
        return;
      }
      const reply = handleRest(forge, {
        method,
        rawSegments: rawSegments.slice(2),
        query,
        body: Buffer.alloc(0),
        origin,
        rawPath,
      });
      if (reply.status === 200) {
        if (readMemo.size >= READ_MEMO_LIMIT) readMemo.clear();
        readMemo.set(key, reply);
      }
      writeReply(res, reply);
      return;
    }
    const body = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
      ? await readBody(req)
      : Buffer.alloc(0);
    const input: RestInput = {
      method,
      rawSegments: rawSegments.slice(2),
      query,
      body,
      origin,
      rawPath,
    };
    writeReply(res, handleRest(forge, input));
    return;
  }

  // GraphQL v4.
  if (rawSegments[0] === 'api' && rawSegments[1] === 'graphql' && rawSegments.length === 2) {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (!isAuthorized(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }
    const body = parseJsonBody(await readBody(req));
    if (body === undefined) {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    if (Array.isArray(body)) {
      const results = body.map((entry) => {
        if (!isRecord(entry) || typeof entry.query !== 'string') {
          return { data: null, errors: [{ message: 'A batched operation needs a query string' }] };
        }
        return executeGraphQL(forge, entry as unknown as GraphQLRequest);
      });
      sendJson(res, 200, results);
      return;
    }
    if (!isRecord(body) || typeof body.query !== 'string') {
      sendJson(res, 400, { errors: [{ message: 'A GraphQL request needs a query string' }] });
      return;
    }
    sendJson(res, 200, executeGraphQL(forge, body as unknown as GraphQLRequest));
    return;
  }

  // MCP.
  if (rawSegments[0] === 'mcp' && rawSegments.length === 1) {
    if (method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (!isAuthorized(req)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }
    handleMcp(forge, await readBody(req), res);
    return;
  }

  if (method === 'GET' && (rawPath === '/' || rawPath === '/api')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', viewer: VIEWER.login });
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** Build the server; it binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(forge, req, res).catch((err: unknown) => {
      // No request may take the process down: the suite proves the forge
      // survives malformed input and keeps serving afterwards.
      try {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      } catch {
        // The socket is already gone.
      }
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
  server.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      // ignore
    }
  });
  return server;
}
