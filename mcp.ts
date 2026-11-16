// mcp.ts -- the MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP.
//
// It speaks both eras the suite accepts: the 2026-07-28 revision, where
// server/discover answers without a handshake, and the legacy initialize /
// notifications/initialized handshake. The tools act on the same store as
// REST and GraphQL, so an object made over one surface reads back over the
// others, ids unchanged. The tools/list answer comes from a fixed table, so
// two calls return it byte for byte.

import type { ServerResponse } from 'node:http';
import { VIEWER, type Forge, type Issue, type Pull, type Repo } from './forge.ts';
import { isRecord } from './webutil.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const STRING = { type: 'string' };

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema({ name: STRING, description: STRING, private: { type: 'boolean' } }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: objectSchema({}, []),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, issue_number: { type: 'integer' } }, ['owner', 'repo', 'issue_number']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) by its number.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, pull_number: { type: 'integer' }, merge_method: STRING },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * Find a tool by the name a caller used. An exact match wins; otherwise the
 * name is matched as a suffix, case-insensitively, so a client that prefixes
 * its tool names (github__create_issue) still lands on the same tool.
 */
function findTool(name: string): ToolDef | undefined {
  const exact = TOOLS_BY_NAME.get(name);
  if (exact !== undefined) return exact;
  const wanted = name.toLowerCase();
  for (const tool of TOOLS) {
    if (wanted === tool.name || wanted.endsWith(`__${tool.name}`)) return tool;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// tool views and execution

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    repository: `${repo.owner}/${repo.name}`,
  };
}

function pullView(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const { head, base } = forge.pullTips(repo, pull);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: head ?? '' },
    base: { ref: pull.baseRef, sha: base ?? '' },
  };
}

/** A tool failure the caller hears about as an isError result, not a crash. */
class ToolFailure extends Error {}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new ToolFailure(`missing required argument: ${key}`);
  return value;
}

function repoOf(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = requiredString(args, 'owner');
  const name = requiredString(args, 'repo');
  const repo = forge.getRepo(owner, name);
  if (repo === null) throw new ToolFailure(`repository ${owner}/${name} not found`);
  return repo;
}

function runTool(forge: Forge, tool: ToolDef, args: Record<string, unknown>): unknown {
  switch (tool.name) {
    case 'create_repo': {
      const name = requiredString(args, 'name');
      if (forge.getRepo(VIEWER.login, name) !== null) {
        throw new ToolFailure(`repository ${name} already exists`);
      }
      const repo = forge.createRepo(
        name,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return repoView(repo);
    }
    case 'get_repo':
      return repoView(repoOf(forge, args));
    case 'list_repos':
      return forge.listRepos().map(repoView);
    case 'create_issue': {
      const repo = repoOf(forge, args);
      const issue = forge.createIssue(
        repo,
        requiredString(args, 'title'),
        typeof args.body === 'string' ? args.body : '',
        [],
      );
      return issueView(repo, issue);
    }
    case 'list_issues': {
      const repo = repoOf(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return issues.map((issue) => issueView(repo, issue));
    }
    case 'get_issue': {
      const repo = repoOf(forge, args);
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.number);
      const issue = repo.issues.get(number);
      if (issue === undefined) throw new ToolFailure(`issue ${number} not found`);
      return issueView(repo, issue);
    }
    case 'create_pull_request': {
      const repo = repoOf(forge, args);
      const title = requiredString(args, 'title');
      const head = requiredString(args, 'head');
      const base = requiredString(args, 'base');
      if (forge.branchTip(repo, head) === null) throw new ToolFailure(`head branch ${head} does not exist`);
      if (forge.branchTip(repo, base) === null) throw new ToolFailure(`base branch ${base} does not exist`);
      const pull = forge.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      return pullView(forge, repo, pull);
    }
    case 'merge_pull_request': {
      const repo = repoOf(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new ToolFailure(`pull request ${number} not found`);
      if (!pull.merged) {
        const sha = forge.mergePull(repo, pull);
        if (sha === null) throw new ToolFailure('the pull request is not mergeable');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = forge.nowIso();
        pull.mergeCommitSha = sha;
        pull.updatedAt = pull.mergedAt;
      }
      return pullView(forge, repo, pull);
    }
    default:
      throw new ToolFailure(`unknown tool ${tool.name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing

interface RpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function sendRpc(res: ServerResponse, status: number, response: RpcResponse): void {
  const text = JSON.stringify(response);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendRpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendRpc(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

/** Handle one POST /mcp; the caller has already enforced the bearer token. */
export function handleMcp(forge: Forge, body: Buffer, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendRpcError(res, 400, null, -32700, 'Parse error');
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => handleOne(forge, entry))
      .filter((entry) => entry !== null);
    const text = JSON.stringify(answers);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  const response = handleOne(forge, parsed);
  if (response === null) {
    // A notification: taken, with no body to answer.
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  sendRpc(res, 200, response);
}

function handleOne(forge: Forge, entry: unknown): RpcResponse | null {
  if (!isRecord(entry) || typeof entry.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const id = 'id' in entry ? entry.id : undefined;
  const isNotification = id === undefined;
  const params = isRecord(entry.params) ? entry.params : {};
  const result = (value: unknown): RpcResponse | null =>
    isNotification ? null : { jsonrpc: '2.0', id, result: value };
  const failure = (code: number, message: string): RpcResponse | null =>
    isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } };

  switch (entry.method) {
    case 'server/discover':
      return result({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return result({ protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = findTool(name);
      if (tool === undefined) return failure(-32602, `unknown tool: ${name}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        const view = runTool(forge, tool, args);
        return result({
          content: [{ type: 'text', text: JSON.stringify(view) }],
          structuredContent: view,
          isError: false,
        });
      } catch (err) {
        if (err instanceof ToolFailure) {
          return result({ content: [{ type: 'text', text: err.message }], isError: true });
        }
        throw err;
      }
    }
    default:
      return failure(-32601, `method not found: ${entry.method}`);
  }
}
