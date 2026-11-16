// rest.ts -- the REST v3 surface: repositories with Link-header pagination, git
// refs and branches, commit listing, the contents API (whose writes are real
// commits on the object store), labels, issues with comments, and pull
// requests with a squash merge.
//
// The read and write benchmark workloads hammer two routes here -- GET one
// issue, POST one issue -- so the issue paths build their replies directly
// from the stored records with no detours.

import type { ServerResponse } from 'node:http';
import { ZERO_OID, peelToCommit } from './gitcore.ts';
import {
  VIEWER,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './forge.ts';
import { isRecord, sendError, sendJson, stringField } from './webutil.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, already percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  /** This server's absolute origin, for Link headers. */
  origin: string;
  /** The request path, for Link headers. */
  path: string;
}

// ---------------------------------------------------------------------------
// JSON shapes

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    type: VIEWER.type,
    name: VIEWER.name,
    email: VIEWER.email,
    avatar_url: '',
    html_url: `/${VIEWER.login}`,
    site_admin: false,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `repo-${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: VIEWER.type },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(name: string, color: string): Record<string, unknown> {
  return { name, color, default: false, description: null };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `issue-${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(name, repo.labels.get(name)?.color ?? 'ededed')),
    comments: issue.comments.length,
    user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: '',
    url: '',
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: '',
    url: '',
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const { head, base } = forge.pullTips(repo, pull);
  return {
    id: pull.id,
    node_id: `pull-${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: head ?? ZERO_OID,
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: base ?? ZERO_OID,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: '',
    url: '',
  };
}

/** An author/committer line ("Name <mail> ts tz") as the API's date shape. */
function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(forge: Forge, oid: string): Record<string, unknown> | null {
  const commit = forge.store.commit(oid);
  if (commit === null) return null;
  return {
    sha: oid,
    node_id: `commit-${oid}`,
    commit: {
      message: commit.message.replace(/\n$/, ''),
      author: parseAuthorLine(commit.author),
      committer: parseAuthorLine(commit.committer),
      tree: { sha: commit.tree, url: '' },
      comment_count: 0,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    committer: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
    html_url: '',
    url: '',
  };
}

// ---------------------------------------------------------------------------
// pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams, fallbackPerPage = 30): Page {
  const perPage = Number(query.get('per_page') ?? fallbackPerPage);
  const page = Number(query.get('page') ?? 1);
  return {
    perPage: Number.isFinite(perPage) && perPage > 0 ? Math.min(100, Math.floor(perPage)) : fallbackPerPage,
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}

function pageSlice<T>(items: T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

/** A Link header naming the next (and last) page while pages remain. */
function linkHeader(req: RestRequest, total: number, page: Page): Record<string, string> {
  if (page.page * page.perPage >= total) return {};
  const withPage = (target: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(page.perPage));
    params.set('page', String(target));
    return `<${req.origin}${req.path}?${params.toString()}>`;
  };
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  return { link: `${withPage(page.page + 1)}; rel="next", ${withPage(lastPage)}; rel="last"` };
}

function notFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found');
}

function unprocessable(res: ServerResponse, message: string): void {
  sendError(res, 422, message);
}

// ---------------------------------------------------------------------------
// routing

export function handleRest(forge: Forge, req: RestRequest, res: ServerResponse): void {
  const { method, segments } = req;

  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    } else {
      notFound(res);
    }
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
    return;
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, userJson());
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    handleViewerRepos(forge, req, res);
    return;
  }
  if (segments[0] !== 'repos' || segments.length < 3) {
    notFound(res);
    return;
  }
  const repo = forge.getRepo(segments[1]!, segments[2]!);
  if (repo === null) {
    notFound(res);
    return;
  }
  handleRepoRest(forge, req, res, repo, segments.slice(3));
}

function handleViewerRepos(forge: Forge, req: RestRequest, res: ServerResponse): void {
  if (req.method === 'POST') {
    if (!isRecord(req.body)) return unprocessable(res, 'Invalid request');
    const name = stringField(req.body, 'name');
    if (name === null || name === '') return unprocessable(res, 'name is required');
    if (forge.getRepo(VIEWER.login, name) !== null) {
      return unprocessable(res, 'name already exists on this account');
    }
    const repo = forge.createRepo(
      name,
      req.body.private === true,
      stringField(req.body, 'description') ?? '',
    );
    return sendJson(res, 201, repoJson(repo));
  }
  if (req.method === 'GET') {
    const all = forge.listRepos();
    const page = pageOf(req.query);
    return sendJson(res, 200, pageSlice(all, page).map(repoJson), linkHeader(req, all.length, page));
  }
  return notFound(res);
}

function handleRepoRest(forge: Forge, req: RestRequest, res: ServerResponse, repo: Repo, rest: string[]): void {
  const { method } = req;

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      if (isRecord(req.body)) {
        const description = stringField(req.body, 'description');
        if (description !== null) repo.description = description;
        const name = stringField(req.body, 'name');
        if (name !== null && name !== '' && name !== repo.name) {
          forge.deleteRepo(repo);
          repo.name = name;
          forge.repos.set(forge.repoKey(repo.owner, name), repo);
        }
        if (typeof req.body.private === 'boolean') repo.isPrivate = req.body.private;
        if (typeof req.body.default_branch === 'string' && req.body.default_branch !== '') {
          repo.defaultBranch = req.body.default_branch;
        }
      }
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': 'forge-delete' });
      res.end();
      return;
    }
    return notFound(res);
  }

  switch (rest[0]) {
    case 'branches':
      return handleBranches(forge, req, res, repo, rest.slice(1));
    case 'git':
      if (rest[1] === 'refs') return handleGitRefs(forge, req, res, repo, rest.slice(2));
      return notFound(res);
    case 'commits':
      if (rest.length === 1) return handleCommits(forge, req, res, repo);
      return notFound(res);
    case 'contents':
      return handleContents(forge, req, res, repo, rest.slice(1).join('/'));
    case 'labels':
      return handleLabels(forge, req, res, repo, rest.slice(1));
    case 'issues':
      return handleIssues(forge, req, res, repo, rest.slice(1));
    case 'pulls':
      return handlePulls(forge, req, res, repo, rest.slice(1));
    default:
      return notFound(res);
  }
}

function handleBranches(forge: Forge, req: RestRequest, res: ServerResponse, repo: Repo, rest: string[]): void {
  if (req.method === 'GET' && rest.length === 0) {
    const branches = forge.branchNames(repo).map((name) => ({
      name,
      commit: { sha: repo.refs.get(`refs/heads/${name}`)!, url: '' },
      protected: false,
    }));
    return sendJson(res, 200, branches);
  }
  if (req.method === 'GET' && rest.length >= 1) {
    const name = rest.join('/');
    const tip = forge.branchTip(repo, name);
    if (tip === null) return notFound(res);
    return sendJson(res, 200, { name, commit: { sha: tip, url: '' }, protected: false });
  }
  return notFound(res);
}

function handleGitRefs(forge: Forge, req: RestRequest, res: ServerResponse, repo: Repo, rest: string[]): void {
  if (req.method === 'POST' && rest.length === 0) {
    if (!isRecord(req.body)) return unprocessable(res, 'Invalid request');
    const ref = stringField(req.body, 'ref');
    const sha = stringField(req.body, 'sha');
    if (ref === null || sha === null) return unprocessable(res, 'ref and sha are required');
    if (!ref.startsWith('refs/')) return unprocessable(res, 'ref must start with refs/');
    if (!forge.store.has(sha)) return unprocessable(res, 'sha does not name an object');
    if (repo.refs.has(ref)) return unprocessable(res, 'Reference already exists');
    repo.refs.set(ref, sha);
    const object = forge.store.get(sha)!;
    return sendJson(res, 201, { ref, node_id: `ref-${ref}`, url: '', object: { type: object.type, sha } });
  }
  if (req.method === 'GET' && rest.length === 0) {
    const all = [...repo.refs.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([ref, sha]) => ({
        ref,
        node_id: `ref-${ref}`,
        url: '',
        object: { type: forge.store.get(sha)?.type ?? 'commit', sha },
      }));
    return sendJson(res, 200, all);
  }
  if ((req.method === 'GET' || req.method === 'DELETE') && rest.length >= 1) {
    const ref = `refs/${rest.join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound(res);
    if (req.method === 'DELETE') {
      repo.refs.delete(ref);
      res.writeHead(204, { 'x-github-request-id': 'forge-delete' });
      res.end();
      return;
    }
    const object = forge.store.get(sha);
    return sendJson(res, 200, { ref, node_id: `ref-${ref}`, url: '', object: { type: object?.type ?? 'commit', sha } });
  }
  return notFound(res);
}

function handleCommits(forge: Forge, req: RestRequest, res: ServerResponse, repo: Repo): void {
  if (req.method !== 'GET') return notFound(res);
  const shaParam = req.query.get('sha');
  const tip = shaParam !== null && shaParam !== ''
    ? forge.resolveCommit(repo, shaParam)
    : forge.headCommit(repo);
  if (tip === null) return sendJson(res, 200, []);
  const all = forge.listCommits(repo, tip);
  const page = pageOf(req.query);
  const items = pageSlice(all, page)
    .map((oid) => commitJson(forge, oid))
    .filter((entry) => entry !== null);
  return sendJson(res, 200, items, linkHeader(req, all.length, page));
}

// ---------------------------------------------------------------------------
// contents

function fileJson(forge: Forge, path: string, blobOid: string): Record<string, unknown> {
  const data = forge.store.get(blobOid)?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: data.toString('base64'),
    sha: blobOid,
    url: '',
    html_url: '',
    download_url: '',
  };
}

function dirEntryJson(forge: Forge, entry: { mode: string; name: string; oid: string }, base: string): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path: base === '' ? entry.name : `${base}/${entry.name}`,
    sha: entry.oid,
    size: isDir ? 0 : (forge.store.get(entry.oid)?.data.length ?? 0),
    url: '',
    html_url: '',
  };
}

function handleContents(forge: Forge, req: RestRequest, res: ServerResponse, repo: Repo, rawPath: string): void {
  const path = rawPath.replace(/^\/+|\/+$/g, '');

  if (req.method === 'GET') {
    const refParam = req.query.get('ref');
    const commit = refParam !== null && refParam !== ''
      ? forge.resolveCommit(repo, refParam)
      : forge.headCommit(repo);
    if (commit === null) return notFound(res);
    const tree = forge.store.commit(commit)!.tree;
    if (path === '') {
      const entries = forge.store.tree(tree) ?? [];
      return sendJson(res, 200, entries.map((entry) => dirEntryJson(forge, entry, '')));
    }
    const blob = forge.blobAtPath(tree, path);
    if (blob !== null) return sendJson(res, 200, fileJson(forge, path, blob));
    const dir = forge.dirEntries(tree, path);
    if (dir !== null) return sendJson(res, 200, dir.map((entry) => dirEntryJson(forge, entry, path)));
    return notFound(res);
  }

  if (req.method === 'PUT') {
    if (!isRecord(req.body)) return unprocessable(res, 'Invalid request');
    const content = stringField(req.body, 'content');
    if (content === null) return unprocessable(res, 'content is required');
    const message = stringField(req.body, 'message') ?? 'update';
    const branch = stringField(req.body, 'branch') ?? repo.defaultBranch;
    const blobOid = forge.store.add('blob', Buffer.from(content.replace(/\s+/g, ''), 'base64'));
    const branchTip = forge.branchTip(repo, branch);
    const branchCommit = branchTip === null ? null : peelToCommit(forge.store, branchTip);
    const existing = branchCommit === null
      ? null
      : forge.blobAtPath(forge.store.commit(branchCommit)!.tree, path);
    const givenSha = stringField(req.body, 'sha');
    if (existing !== null && givenSha !== existing) {
      return sendError(res, 409, `${path} has changed since the sha was read`);
    }
    const { commitOid } = forge.commitFileChange(repo, branch, path, blobOid, message);
    return sendJson(res, existing !== null ? 200 : 201, {
      content: fileJson(forge, path, blobOid),
      commit: commitJson(forge, commitOid) ?? { sha: commitOid },
    });
  }

  if (req.method === 'DELETE') {
    if (!isRecord(req.body)) return unprocessable(res, 'Invalid request');
    const message = stringField(req.body, 'message') ?? 'delete';
    const branch = stringField(req.body, 'branch') ?? repo.defaultBranch;
    const branchTip = forge.branchTip(repo, branch);
    const branchCommit = branchTip === null ? null : peelToCommit(forge.store, branchTip);
    if (branchCommit === null) return notFound(res);
    const existing = forge.blobAtPath(forge.store.commit(branchCommit)!.tree, path);
    if (existing === null) return notFound(res);
    const givenSha = stringField(req.body, 'sha');
    if (givenSha !== null && givenSha !== existing) {
      return sendError(res, 409, `${path} has changed since the sha was read`);
    }
    const { commitOid } = forge.commitFileChange(repo, branch, path, null, message);
    return sendJson(res, 200, { content: null, commit: commitJson(forge, commitOid) ?? { sha: commitOid } });
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------
// labels

function handleLabels(forge: Forge, req: RestRequest, res: ServerResponse, repo: Repo, rest: string[]): void {
  if (req.method === 'GET' && rest.length === 0) {
    const labels = [...repo.labels.values()].map((label) => labelJson(label.name, label.color));
    return sendJson(res, 200, labels);
  }
  if (req.method === 'POST' && rest.length === 0) {
    if (!isRecord(req.body)) return unprocessable(res, 'Invalid request');
    const name = stringField(req.body, 'name');
    if (name === null || name === '') return unprocessable(res, 'name is required');
    if (repo.labels.has(name)) return unprocessable(res, 'Label already exists');
    const color = (stringField(req.body, 'color') ?? 'ededed').replace(/^#/, '');
    repo.labels.set(name, { name, color });
    return sendJson(res, 201, { id: forge.nextEntityId(), ...labelJson(name, color) });
  }
  return notFound(res);
}

// ---------------------------------------------------------------------------
// issues

/** Label names out of a request value: strings, or objects carrying a name. */
function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
  }
  return names;
}

function handleIssues(forge: Forge, req: RestRequest, res: ServerResponse, repo: Repo, rest: string[]): void {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((issue) => issue.state === 'open');
      else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
      const ascending = (req.query.get('direction') ?? 'desc') === 'asc';
      items.sort((a, b) => (ascending ? a.seq - b.seq : b.seq - a.seq));
      const page = pageOf(req.query);
      return sendJson(res, 200, pageSlice(items, page).map((issue) => issueJson(repo, issue)), linkHeader(req, items.length, page));
    }
    if (req.method === 'POST') {
      if (!isRecord(req.body)) return unprocessable(res, 'Invalid request');
      const title = stringField(req.body, 'title');
      if (title === null || title === '') return unprocessable(res, 'title is required');
      const labels = labelNamesOf(req.body.labels);
      for (const label of labels) {
        if (!repo.labels.has(label)) return unprocessable(res, `label "${label}" does not exist`);
      }
      const issue = forge.createIssue(repo, title, stringField(req.body, 'body') ?? '', labels);
      return sendJson(res, 201, issueJson(repo, issue));
    }
    return notFound(res);
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound(res);
  const issue = repo.issues.get(number);

  if (rest.length === 1) {
    if (issue === undefined) return notFound(res);
    if (req.method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (req.method === 'PATCH') {
      if (isRecord(req.body)) {
        const state = stringField(req.body, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = stringField(req.body, 'title');
        if (title !== null) issue.title = title;
        const body = stringField(req.body, 'body');
        if (body !== null) issue.body = body;
        if (req.body.labels !== undefined) {
          const labels = labelNamesOf(req.body.labels);
          for (const label of labels) {
            if (!repo.labels.has(label)) return unprocessable(res, `label "${label}" does not exist`);
          }
          issue.labels = labels;
        }
        issue.updatedAt = forge.nowIso();
      }
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return notFound(res);
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound(res);
    if (req.method === 'GET') return sendJson(res, 200, issue.comments.map(commentJson));
    if (req.method === 'POST') {
      if (!isRecord(req.body)) return unprocessable(res, 'Invalid request');
      const body = stringField(req.body, 'body');
      if (body === null) return unprocessable(res, 'body is required');
      const comment = { id: forge.nextEntityId(), body, createdAt: forge.nowIso() };
      issue.comments.push(comment);
      return sendJson(res, 201, commentJson(comment));
    }
    return notFound(res);
  }

  if (rest.length === 2 && rest[1] === 'labels' && req.method === 'POST') {
    if (issue === undefined) return notFound(res);
    if (!isRecord(req.body)) return unprocessable(res, 'Invalid request');
    const labels = labelNamesOf(Array.isArray(req.body) ? req.body : req.body.labels);
    for (const label of labels) {
      if (!repo.labels.has(label)) return unprocessable(res, `label "${label}" does not exist`);
      if (!issue.labels.includes(label)) issue.labels.push(label);
    }
    return sendJson(res, 200, issue.labels.map((name) => labelJson(name, repo.labels.get(name)?.color ?? 'ededed')));
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------
// pull requests

function handlePulls(forge: Forge, req: RestRequest, res: ServerResponse, repo: Repo, rest: string[]): void {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((pull) => pull.state === 'open');
      else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
      items.sort((a, b) => b.seq - a.seq);
      const page = pageOf(req.query);
      return sendJson(res, 200, pageSlice(items, page).map((pull) => pullJson(forge, repo, pull)), linkHeader(req, items.length, page));
    }
    if (req.method === 'POST') {
      if (!isRecord(req.body)) return unprocessable(res, 'Invalid request');
      const head = stringField(req.body, 'head');
      const base = stringField(req.body, 'base');
      if (head === null || base === null) return unprocessable(res, 'head and base are required');
      if (forge.branchTip(repo, head) === null) return unprocessable(res, `head branch "${head}" does not exist`);
      if (forge.branchTip(repo, base) === null) return unprocessable(res, `base branch "${base}" does not exist`);
      const duplicate = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate !== undefined) {
        return unprocessable(res, `A pull request already exists for ${head} into ${base}`);
      }
      const pull = forge.createPull(
        repo,
        stringField(req.body, 'title') ?? '',
        stringField(req.body, 'body') ?? '',
        head,
        base,
      );
      return sendJson(res, 201, pullJson(forge, repo, pull));
    }
    return notFound(res);
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound(res);
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound(res);

  if (rest.length === 1) {
    if (req.method === 'GET') return sendJson(res, 200, pullJson(forge, repo, pull));
    if (req.method === 'PATCH') {
      if (isRecord(req.body)) {
        const state = stringField(req.body, 'state');
        if ((state === 'open' || state === 'closed') && !pull.merged) pull.state = state;
        const title = stringField(req.body, 'title');
        if (title !== null) pull.title = title;
        const body = stringField(req.body, 'body');
        if (body !== null) pull.body = body;
        pull.updatedAt = forge.nowIso();
      }
      return sendJson(res, 200, pullJson(forge, repo, pull));
    }
    return notFound(res);
  }

  if (rest.length === 2 && rest[1] === 'files' && req.method === 'GET') {
    const files = forge.pullDiff(repo, pull).map((file) => ({
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      sha: '',
    }));
    return sendJson(res, 200, files);
  }

  if (rest.length === 2 && rest[1] === 'merge' && req.method === 'PUT') {
    if (pull.merged || pull.state !== 'open') {
      return sendError(res, 405, 'Pull Request is not mergeable');
    }
    const sha = forge.mergePull(repo, pull);
    if (sha === null) return sendError(res, 405, 'Pull Request is not mergeable');
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = forge.nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    return sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound(res);
}
