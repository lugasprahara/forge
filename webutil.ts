// http.ts -- the plumbing every surface shares: reading request bodies,
// writing replies in the shapes the suite asserts (JSON answers carry a
// non-empty X-GitHub-Request-Id), and guards for untrusted JSON.
//
// REST handlers do not write to the socket themselves: they return a
// RestReply (status + serialized body + extra headers) and the front door
// writes it. That split is what lets the front door memoize GET answers
// byte for byte instead of re-serializing them per request.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A fresh, non-empty request id for a reply's headers. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Read a request body to its end as one buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let first: Buffer | null = null;
    let rest: Buffer[] | null = null;
    req.on('data', (chunk: Buffer) => {
      if (rest !== null) rest.push(chunk);
      else if (first === null) first = chunk;
      else {
        rest = [first, chunk];
        first = null;
      }
    });
    req.on('end', () => {
      if (rest !== null) resolve(Buffer.concat(rest));
      else resolve(first ?? Buffer.alloc(0));
    });
    req.on('error', reject);
  });
}

/** What a REST handler decided: a status, a serialized body, extra headers. */
export interface RestReply {
  status: number;
  text: string;
  headers?: Readonly<Record<string, string>>;
}

/** A JSON reply from a value (serialized once, here). */
export function jsonReply(status: number, value: unknown, headers?: Record<string, string>): RestReply {
  return { status, text: `${JSON.stringify(value)}\n`, headers };
}

/** A GitHub-shaped error reply: a JSON body carrying a string message. */
export function errorReply(status: number, message: string): RestReply {
  return jsonReply(status, { message });
}

/** A reply with no body at all (204s). */
export function emptyReply(status: number): RestReply {
  return { status, text: '' };
}

/** Write a RestReply to the socket with the suite's expected headers. */
export function writeReply(res: ServerResponse, reply: RestReply): void {
  if (reply.status === 204 || reply.text === '') {
    res.writeHead(reply.status, { 'x-github-request-id': nextRequestId(), ...reply.headers });
    res.end();
    return;
  }
  res.writeHead(reply.status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(reply.text),
    'x-github-request-id': nextRequestId(),
    ...reply.headers,
  });
  res.end(reply.text);
}

/** Write a JSON value straight to the socket (the non-REST surfaces). */
export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  writeReply(res, jsonReply(status, value));
}

/** A GitHub-shaped error straight to the socket. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  writeReply(res, errorReply(status, message));
}

/** Parse a JSON request body; `undefined` marks malformed JSON. */
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

/** The string at `key` in a JSON object body, or null when absent/not one. */
export function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}
