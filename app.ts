// The HTTP surface: one server routing the four surfaces the suite drives —
//   GET  /healthz                              the env's boot probe
//   /{owner}/{repo}.git/info/refs|git-upload-pack|git-receive-pack   git smart HTTP
//   /api/v3/*                                  REST v3
//   /api/graphql                               GraphQL v4
//   /mcp                                       MCP (JSON-RPC over Streamable HTTP)
// Auth: the trial token (MAKEFUN_SHOP_TOKEN) as a Bearer token on the API
// surfaces; a request without it is a 401. Git smart HTTP answers the suite's
// client, which presents the same token, and stays readable like a public repo.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER } from './forge.ts';
import { advertise, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { executeGraphQL, type GraphQLRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { isRecord, parseJsonBody, readBody, sendError, sendJson } from './webutil.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function isAuthorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}`;
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const { pathname, query } = pathOf(req);
  const segments = pathname.split('/').filter((part) => part !== '').map(decodeSegment);

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    const repo = forge.getRepo(owner, repoName);
    const tail = segments.slice(2).join('/');
    if (method === 'GET' && tail === 'info/refs') {
      if (repo === null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('repository not found\n');
        return;
      }
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
    if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
      if (repo === null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('repository not found\n');
        return;
      }
      const body = await readBody(req);
      if (tail === 'git-upload-pack') handleUploadPack(forge, repo, body, res);
      else await handleReceivePack(forge, repo, body, res);
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
    const host = req.headers.host ?? 'entry';
    const restRequest: RestRequest = {
      method,
      segments: segments.slice(2),
      query,
      body,
      origin: `http://${host}`,
      path: pathname,
    };
    handleRest(forge, restRequest, res);
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
    const body = await readBody(req);
    handleMcp(forge, body, res);
    return;
  }

  // The API root also answers outside the /api/v3 prefix handling above.
  if (method === 'GET' && (pathname === '/' || pathname === '/api')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', viewer: VIEWER.login });
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(forge, req, res).catch((err: unknown) => {
      // A request must never take the process down: the suite proves the server
      // survives malformed input and keeps serving afterwards.
      try {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      } catch {
        // The socket is already gone; nothing more to do.
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
