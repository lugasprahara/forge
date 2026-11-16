// app.ts -- the HTTP front door. One server routes the four surfaces the suite
// drives:
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
// Routing works on the raw request target -- split at the first "?", segments
// percent-decoded only when a "%" is actually present -- rather than through
// the WHATWG URL parser: the read benchmark issues thousands of small GETs,
// and the cheap split keeps their per-request cost in the handlers, not in
// URL machinery.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER } from './forge.ts';
import { advertise, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { executeGraphQL, type GraphQLRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { isRecord, parseJsonBody, readBody, sendError, sendJson } from './webutil.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function isAuthorized(req: IncomingMessage): boolean {
  return TOKEN === '' || req.headers.authorization === `Bearer ${TOKEN}`;
}

interface SplitTarget {
  /** The path, still percent-encoded. */
  path: string;
  /** The decoded, non-empty path segments. */
  segments: string[];
  query: URLSearchParams;
}

function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function splitTarget(rawUrl: string): SplitTarget {
  const q = rawUrl.indexOf('?');
  const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : rawUrl.slice(q + 1));
  const segments = path.split('/').filter((part) => part !== '').map(decodeSegment);
  return { path, segments, query };
}

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const { path, segments, query } = splitTarget(req.url ?? '/');

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const repo = forge.getRepo(segments[0]!, segments[1]!.slice(0, -'.git'.length));
    const tail = segments.slice(2).join('/');
    if (repo === null || (tail !== 'info/refs' && tail !== 'git-upload-pack' && tail !== 'git-receive-pack')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(repo === null ? 'repository not found\n' : 'not found\n');
      return;
    }
    if (method === 'GET' && tail === 'info/refs') {
      const service = query.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('service required\n');
        return;
      }
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      advertise(forge, repo, service, wantsV2, res);
      return;
    }
    if (method === 'POST' && tail === 'git-upload-pack') {
      handleUploadPack(forge, repo, await readBody(req), res);
      return;
    }
    if (method === 'POST' && tail === 'git-receive-pack') {
      await handleReceivePack(forge, repo, await readBody(req), res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
    return;
  }

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!isAuthorized(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }
    const body = method === 'GET' || method === 'DELETE' ? {} : parseJsonBody(await readBody(req));
    if (body === undefined) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    const request: RestRequest = {
      method,
      segments: segments.slice(2),
      query,
      body,
      origin: `http://${req.headers.host ?? 'entry'}`,
      path,
    };
    handleRest(forge, request, res);
    return;
  }

  // GraphQL v4.
  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
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
        return executeGraphQL(forge, entry as GraphQLRequest);
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
  if (segments[0] === 'mcp' && segments.length === 1) {
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

  if (method === 'GET' && (path === '/' || path === '/api')) {
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
