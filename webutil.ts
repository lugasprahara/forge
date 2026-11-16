// webutil.ts -- the HTTP plumbing every surface shares: reading request bodies,
// answering JSON in the shape the suite asserts (a JSON content type and a
// non-empty X-GitHub-Request-Id on every reply), GitHub-shaped error bodies,
// and small guards for untrusted JSON.

import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
let requestSequence = 0;

/** A fresh, non-empty request id for the reply headers. */
export function nextRequestId(): string {
  requestSequence += 1;
  return `req-${requestSequence.toString(16).padStart(8, '0')}`;
}

/** Read a request body to its end as one buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Send `body` as JSON with the suite's expected headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

/** Send a pre-serialized JSON text (for answers that must be byte-stable). */
export function sendJsonText(
  res: ServerResponse,
  status: number,
  text: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

/** A GitHub-shaped error: a JSON body carrying a string message. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Parse a JSON request body; `undefined` marks malformed JSON (a 400 upstream). */
export function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether `value` is a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The string at `key` in a JSON object body, or null when absent or not one. */
export function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}
