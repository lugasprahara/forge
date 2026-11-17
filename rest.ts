// rest.ts -- the REST v3 surface: the viewer, repositories, the contents
// API, labels, issues, comments and pull requests, in GitHub's shapes.
//
// Handlers return RestReply values rather than touching the socket (see
// webutil.ts), which is what lets the front door serve repeated reads from
// its memo. Validation order and error strings follow GitHub's observable
// behavior: a missing owner reads as absent (404, never 403), a stale
// contents sha is a 409, and label problems are 422s.

import { peelCommit, readCommit } from './gitcore.ts';
import { emptyReply, errorReply, isRecord, jsonReply, parseJsonBody, stringField, type RestReply } from './webutil.ts';
import { VIEWER, type Forge, type Issue, type Label, type Pull, type Repo } from './forge.ts';

export interface RestInput {
  method: string;
  /** Raw (still percent-encoded) path segments after /api/v3. */
  rawSegments: string[];
  query: URLSearchParams | null;
  body: Buffer;
  origin: string;
  rawPath: string;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// JSON shapes

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type, name: VIEWER.name, email: VIEWER.email };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

function labelIndex(repo: Repo, name: string): number {
  let index = 0;
  for (const key of repo.labels.keys()) {
    if (key === name) return index;
    index += 1;
  }
  return 0;
}

function labelJson(label: Label, index: number): Record<string, unknown> {
  return {
    id: 5000 + index,
    node_id: `LA_${5000 + index}`,
    name: label.name,
    color: label.color,
    default: false,
    description: null,
    url: '',
  };
}

function issueLabelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return label === undefined
    ? { id: 0, node_id: 'LA_0', name, color: 'ededed', default: false, description: null, url: '' }
    : labelJson(label, labelIndex(repo, name));
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => issueLabelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: '',
    url: '',
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const tips = repoOwnerTips(repo, pull);
  const side = (ref: string, sha: string | null) => ({
    ref,
    sha,
    label: `${repo.owner}:${ref}`,
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    head: side(pull.headRef, tips.head),
    base: side(pull.baseRef, tips.base),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function repoOwnerTips(repo: Repo, pull: Pull): { head: string | null; base: string | null } {
  return {
    head: repo.refs.get(`refs/heads/${pull.headRef}`) ?? null,
    base: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null,
  };
}

function commitJson(forge: Forge, oid: string): Record<string, unknown> | null {
  const object = forge.store.get(oid);
  if (object === undefined) return null;
  const commit = readCommit(object.data);
  const person = (line: string) => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
    return {
      name: match?.[1] ?? '',
      email: match?.[2] ?? '',
      date: new Date(Number(match?.[3] ?? 0) * 1000).toISOString(),
    };
  };
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      author: person(commit.author),
      committer: person(commit.committer),
    },
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
    url: '',
    html_url: '',
  };
}

// ---------------------------------------------------------------------------
// pagination

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams | null): Page {
  const positive = (raw: string | null, fallback: number): number => {
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    page: positive(query?.get('page') ?? null, 1),
    perPage: Math.min(100, positive(query?.get('per_page') ?? null, 30)),
  };
}

function paginate<T>(input: RestInput, items: T[]): { pageItems: T[]; headers?: Record<string, string> } {
  const { page, perPage } = pageOf(input.query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  if (items.length <= perPage) return { pageItems };
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const base = `${input.origin}${input.rawPath}`;
  const links: string[] = [];
  if (page < lastPage) links.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  links.push(`<${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`);
  return { pageItems, headers: { link: links.join(', ') } };
}

// ---------------------------------------------------------------------------
// the router

export function handleRest(forge: Forge, input: RestInput): RestReply {
  const seg = input.rawSegments.map(decode);
  const { method } = input;

  // The API root and the meta probe live outside the resource tree.
  if (seg.length === 0 && method === 'GET') {
    return jsonReply(200, {
      current_user_url: '/api/v3/user',
      user_url: '/api/v3/users/{user}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, user' });
  }
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    return jsonReply(200, { installed_version: '3.0.0' });
  }

  if (seg[0] === 'user') {
    if (seg.length === 1 && method === 'GET') return jsonReply(200, userJson());
    if (seg.length === 2 && seg[1] === 'repos') {
      if (method === 'GET') {
        const { pageItems, headers } = paginate(input, forge.listRepos());
        return jsonReply(200, pageItems.map(repoJson), headers);
      }
      if (method === 'POST') return createRepo(forge, input);
    }
    return errorReply(404, 'Not Found');
  }

  if (seg[0] !== 'repos' || seg.length < 3) return errorReply(404, 'Not Found');
  const owner = seg[1]!;
  const repoName = seg[2]!;

  if (seg.length === 3) {
    if (method === 'POST') return errorReply(404, 'Not Found');
    const repo = forge.getRepo(owner, repoName);
    if (repo === null) return errorReply(404, 'Not Found');
    if (method === 'GET') return jsonReply(200, repoJson(repo));
    if (method === 'PATCH') {
      const body = parseJsonBody(input.body);
      if (body === undefined) return errorReply(400, 'Problems parsing JSON');
      if (isRecord(body)) {
        const description = stringField(body, 'description');
        if (description !== null) repo.description = description;
        const name = stringField(body, 'name');
        if (name !== null && name !== '' && name !== repo.name) {
          forge.repos.delete(forge.repoKey(repo.owner, repo.name));
          repo.name = name;
          forge.repos.set(forge.repoKey(repo.owner, name), repo);
        }
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        const defaultBranch = stringField(body, 'default_branch');
        if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
        forge.touch();
      }
      return jsonReply(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return emptyReply(204);
    }
    return errorReply(404, 'Not Found');
  }

  const repo = forge.getRepo(owner, repoName);
  if (repo === null) return errorReply(404, 'Not Found');
  const section = seg[3]!;

  if (section === 'commits' && seg.length === 4 && method === 'GET') {
    const shaParam = input.query?.get('sha') ?? null;
    let list: string[] = [];
    if (shaParam !== null && shaParam !== '') {
      const start = forge.resolveCommit(repo, shaParam);
      if (start === null) return errorReply(404, 'Not Found');
      list = forge.listCommits(start);
    } else {
      const tip = forge.branchTip(repo, repo.defaultBranch);
      list = tip === null ? [] : forge.listCommits(tip);
    }
    const { pageItems, headers } = paginate(input, list);
    const json = pageItems.map((oid) => commitJson(forge, oid)).filter((entry) => entry !== null);
    return jsonReply(200, json, headers);
  }

  if (section === 'branches' && method === 'GET') {
    if (seg.length === 4) {
      const branches = forge.branchNames(repo).map((name) => ({
        name,
        commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '', url: '' },
        protected: false,
      }));
      return jsonReply(200, branches);
    }
    if (seg.length === 5) {
      const name = seg[4]!;
      const tip = forge.branchTip(repo, name);
      if (tip === null) return errorReply(404, 'Not Found');
      return jsonReply(200, { name, commit: { sha: tip, url: '' }, protected: false });
    }
    return errorReply(404, 'Not Found');
  }

  if (section === 'git' && seg[4] === 'refs') return gitRefs(forge, repo, input, seg);

  if (section === 'contents') return contents(forge, repo, input);
  if (section === 'labels') return labels(forge, repo, input, seg);
  if (section === 'issues') return issues(forge, repo, input, seg);
  if (section === 'pulls') return pulls(forge, repo, input, seg);
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// repositories

function createRepo(forge: Forge, input: RestInput): RestReply {
  const body = parseJsonBody(input.body);
  if (body === undefined) return errorReply(400, 'Problems parsing JSON');
  const fields = isRecord(body) ? body : {};
  const name = stringField(fields, 'name');
  if (name === null || name === '') return errorReply(422, 'name is required');
  if (forge.getRepo(VIEWER.login, name) !== null) return errorReply(422, 'name already exists on this account');
  const repo = forge.createRepo(name, fields.private === true, stringField(fields, 'description') ?? '');
  return jsonReply(201, repoJson(repo));
}

// ---------------------------------------------------------------------------
// contents

function contents(forge: Forge, repo: Repo, input: RestInput): RestReply {
  const ref = input.query?.get('ref') ?? null;
  const headCommit = ref !== null ? forge.resolveCommit(repo, ref) : forge.headCommit(repo);

  if (input.method === 'GET') {
    if (headCommit === null) return errorReply(404, 'Not Found');
    const treeOid = forge.store.commit(headCommit)!.tree;
    const path = input.rawSegments.slice(4).join('/');
    const listing = (items: Array<{ mode: string; name: string; oid: string }>, prefix: string) =>
      items.map((item) => {
        const isDir = item.mode === '40000';
        return {
          name: item.name,
          path: prefix === '' ? item.name : `${prefix}/${item.name}`,
          sha: item.oid,
          size: isDir ? 0 : (forge.store.get(item.oid)?.data.length ?? 0),
          type: isDir ? 'dir' : 'file',
          url: '',
          html_url: '',
          download_url: null,
          _links: { self: '', git: '', html: '' },
        };
      });
    if (path === '') return jsonReply(200, listing(forge.topEntries(headCommit), ''));
    if (forge.isDirAt(treeOid, path)) {
      return jsonReply(200, listing(forge.dirEntries(treeOid, path) ?? [], path));
    }
    const blobOid = forge.blobAt(treeOid, path);
    if (blobOid === null) return errorReply(404, 'Not Found');
    const data = forge.store.get(blobOid)!.data;
    const base64 = data.toString('base64');
    const wrapped = base64 === '' ? '' : `${base64.replace(/.{60}/g, '$&\n')}\n`;
    return jsonReply(200, {
      name: path.split('/').pop(),
      path,
      sha: blobOid,
      size: data.length,
      type: 'file',
      encoding: 'base64',
      content: wrapped,
      url: '',
      html_url: '',
      download_url: null,
      _links: { self: '', git: '', html: '' },
    });
  }

  if (input.method !== 'PUT' && input.method !== 'DELETE') return errorReply(404, 'Not Found');
  const path = input.rawSegments.slice(4).map(decode).join('/');
  const body = parseJsonBody(input.body);
  if (body === undefined) return errorReply(400, 'Problems parsing JSON');
  const fields = isRecord(body) ? body : {};
  const message = stringField(fields, 'message');
  if (message === null || message === '') return errorReply(422, 'message is required');
  const branch = stringField(fields, 'branch') ?? repo.defaultBranch;
  const tipCommit = (() => {
    const tip = forge.branchTip(repo, branch);
    return tip === null ? null : peelCommit(forge.store, tip);
  })();
  const currentBlob = tipCommit === null
    ? null
    : forge.blobAt(forge.store.commit(tipCommit)!.tree, path);
  const sha = stringField(fields, 'sha');

  if (input.method === 'PUT') {
    const content = stringField(fields, 'content');
    if (content === null) return errorReply(422, 'content is required');
    if (currentBlob !== null) {
      if (sha === null) return errorReply(422, 'sha is required when updating an existing file');
      if (sha !== currentBlob) return errorReply(409, 'sha does not match');
    } else if (sha !== null) {
      return errorReply(422, 'sha must be omitted when creating a new file');
    }
    const data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    const blobOid = forge.store.add('blob', data);
    const { commitOid, treeOid } = forge.commitFileChange(repo, branch, path, blobOid, message);
    void treeOid;
    return jsonReply(currentBlob !== null ? 200 : 201, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        url: '',
        html_url: '',
        download_url: null,
      },
      commit: commitJson(forge, commitOid),
    });
  }

  // DELETE
  if (sha === null) return errorReply(422, 'sha is required');
  if (currentBlob === null) return errorReply(404, 'Not Found');
  if (sha !== currentBlob) return errorReply(409, 'sha does not match');
  const { commitOid } = forge.commitFileChange(repo, branch, path, null, message);
  return jsonReply(200, { content: null, commit: commitJson(forge, commitOid) });
}

// ---------------------------------------------------------------------------
// git refs (the Git Data API's ref endpoints)

function refJson(forge: Forge, ref: string, oid: string): Record<string, unknown> {
  const object = forge.store.get(oid);
  return {
    ref,
    node_id: `REF_${ref}`,
    url: '',
    object: { sha: oid, type: object?.type ?? 'commit', url: '' },
  };
}

function gitRefs(forge: Forge, repo: Repo, input: RestInput, seg: string[]): RestReply {
  if (seg.length === 5) {
    if (input.method === 'GET') {
      const all = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([ref, oid]) => refJson(forge, ref, oid));
      return jsonReply(200, all);
    }
    if (input.method === 'POST') {
      const body = parseJsonBody(input.body);
      if (body === undefined) return errorReply(400, 'Problems parsing JSON');
      const fields = isRecord(body) ? body : {};
      const ref = stringField(fields, 'ref');
      if (ref === null || !ref.startsWith('refs/')) return errorReply(422, 'ref is required');
      const sha = stringField(fields, 'sha');
      if (sha === null || !forge.store.has(sha)) return errorReply(422, 'Invalid sha');
      if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
      forge.setRef(repo, ref, sha);
      return jsonReply(201, refJson(forge, ref, sha));
    }
    return errorReply(404, 'Not Found');
  }
  const ref = seg.slice(5).join('/');
  const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
  const oid = repo.refs.get(fullRef);
  if (input.method === 'GET') {
    if (oid === undefined) return errorReply(404, 'Not Found');
    return jsonReply(200, refJson(forge, fullRef, oid));
  }
  if (input.method === 'DELETE') {
    if (oid === undefined) return errorReply(404, 'Not Found');
    forge.deleteRef(repo, fullRef);
    return emptyReply(204);
  }
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// labels

function labels(forge: Forge, repo: Repo, input: RestInput, seg: string[]): RestReply {
  if (seg.length === 4) {
    if (input.method === 'GET') {
      return jsonReply(200, [...repo.labels.values()].map((label, index) => labelJson(label, index)));
    }
    if (input.method === 'POST') {
      const body = parseJsonBody(input.body);
      if (body === undefined) return errorReply(400, 'Problems parsing JSON');
      const fields = isRecord(body) ? body : {};
      const name = stringField(fields, 'name');
      if (name === null || name === '') return errorReply(422, 'name is required');
      if (repo.labels.has(name)) return errorReply(422, 'Validation Failed: label already exists');
      const label: Label = { name, color: stringField(fields, 'color') ?? 'ededed' };
      repo.labels.set(name, label);
      forge.touch();
      return jsonReply(201, labelJson(label, labelIndex(repo, name)));
    }
    return errorReply(404, 'Not Found');
  }
  if (seg.length === 5 && input.method === 'GET') {
    const label = repo.labels.get(seg[4]!);
    if (label === undefined) return errorReply(404, 'Not Found');
    return jsonReply(200, labelJson(label, labelIndex(repo, label.name)));
  }
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// issues

function requestedLabels(fields: Record<string, unknown>): string[] | null {
  const raw = fields.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

function labelsExist(repo: Repo, names: string[]): boolean {
  return names.every((name) => repo.labels.has(name));
}

function issues(forge: Forge, repo: Repo, input: RestInput, seg: string[]): RestReply {
  if (seg.length === 4) {
    if (input.method === 'GET') {
      const state = input.query?.get('state') ?? null;
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      const direction = input.query?.get('direction') ?? null;
      if (direction === 'asc') list.sort((a, b) => a.seq - b.seq);
      else if (direction === 'desc') list.sort((a, b) => b.seq - a.seq);
      else list.sort((a, b) => a.number - b.number);
      const { pageItems, headers } = paginate(input, list);
      return jsonReply(200, pageItems.map((issue) => issueJson(repo, issue)), headers);
    }
    if (input.method === 'POST') {
      const body = parseJsonBody(input.body);
      if (body === undefined) return errorReply(400, 'Problems parsing JSON');
      const fields = isRecord(body) ? body : {};
      const title = stringField(fields, 'title');
      if (title === null || title === '') return errorReply(422, 'title is required');
      const names = requestedLabels(fields) ?? [];
      if (!labelsExist(repo, names)) return errorReply(422, 'Validation Failed: label not found');
      const issue = forge.createIssue(repo, title, stringField(fields, 'body') ?? '', names);
      return jsonReply(201, issueJson(repo, issue));
    }
    return errorReply(404, 'Not Found');
  }

  const number = Number(seg[4]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) return errorReply(404, 'Not Found');

  if (seg.length === 5) {
    if (input.method === 'GET') return jsonReply(200, issueJson(repo, issue));
    if (input.method === 'PATCH') {
      const body = parseJsonBody(input.body);
      if (body === undefined) return errorReply(400, 'Problems parsing JSON');
      const fields = isRecord(body) ? body : {};
      const names = fields.labels === undefined ? null : requestedLabels(fields);
      if (names !== null && !labelsExist(repo, names)) {
        return errorReply(422, 'Validation Failed: label not found');
      }
      const title = stringField(fields, 'title');
      if (title !== null && title !== '') issue.title = title;
      const text = stringField(fields, 'body');
      if (text !== null) issue.body = text;
      if (fields.state === 'open' || fields.state === 'closed') issue.state = fields.state;
      if (names !== null) issue.labels = names;
      issue.updatedAt = forge.nowIso();
      forge.touch();
      return jsonReply(200, issueJson(repo, issue));
    }
    return errorReply(404, 'Not Found');
  }

  if (seg[5] === 'comments') {
    if (seg.length === 6 && input.method === 'GET') {
      return jsonReply(200, issue.comments.map(commentJson));
    }
    if (seg.length === 6 && input.method === 'POST') {
      const body = parseJsonBody(input.body);
      if (body === undefined) return errorReply(400, 'Problems parsing JSON');
      const fields = isRecord(body) ? body : {};
      const text = stringField(fields, 'body');
      if (text === null || text === '') return errorReply(422, 'body is required');
      const comment = { id: forge.nextEntityId(), body: text, createdAt: forge.nowIso() };
      issue.comments.push(comment);
      issue.updatedAt = comment.createdAt;
      forge.touch();
      return jsonReply(201, commentJson(comment));
    }
    return errorReply(404, 'Not Found');
  }

  if (seg[5] === 'labels') {
    const current = (): RestReply => jsonReply(200, issue.labels.map((name) => issueLabelJson(repo, name)));
    if (seg.length === 6 && input.method === 'GET') return current();
    if (seg.length === 6 && (input.method === 'POST' || input.method === 'PUT')) {
      const body = parseJsonBody(input.body);
      if (body === undefined) return errorReply(400, 'Problems parsing JSON');
      const fields = isRecord(body) ? body : {};
      const names = requestedLabels(fields);
      if (names === null || !labelsExist(repo, names)) {
        return errorReply(422, 'Validation Failed: label not found');
      }
      if (input.method === 'PUT') issue.labels = [];
      for (const name of names) if (!issue.labels.includes(name)) issue.labels.push(name);
      issue.updatedAt = forge.nowIso();
      forge.touch();
      return current();
    }
    if (seg.length === 6 && input.method === 'DELETE') {
      issue.labels = [];
      forge.touch();
      return jsonReply(200, []);
    }
    if (seg.length === 7 && input.method === 'DELETE') {
      issue.labels = issue.labels.filter((name) => name !== seg[6]);
      forge.touch();
      return current();
    }
    return errorReply(404, 'Not Found');
  }

  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests

function pulls(forge: Forge, repo: Repo, input: RestInput, seg: string[]): RestReply {
  if (seg.length === 4) {
    if (input.method === 'GET') {
      const state = input.query?.get('state') ?? null;
      let list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      // GitHub's default listing is open pull requests only; state=all
      // lifts the filter, and merged pulls read as closed.
      if (state === null || state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      const { pageItems, headers } = paginate(input, list);
      return jsonReply(200, pageItems.map((pull) => pullJson(repo, pull)), headers);
    }
    if (input.method === 'POST') {
      const body = parseJsonBody(input.body);
      if (body === undefined) return errorReply(400, 'Problems parsing JSON');
      const fields = isRecord(body) ? body : {};
      const title = stringField(fields, 'title');
      if (title === null || title === '') return errorReply(422, 'title is required');
      const head = stringField(fields, 'head');
      if (head === null || head === '') return errorReply(422, 'head is required');
      const base = stringField(fields, 'base') ?? repo.defaultBranch;
      const headTip = forge.branchTip(repo, head);
      if (headTip === null) return errorReply(422, 'Invalid head');
      const baseTip = forge.branchTip(repo, base);
      if (baseTip === null) return errorReply(422, 'Invalid base');
      if (headTip === baseTip) return errorReply(422, 'No commits between base and head');
      const pull = forge.createPull(repo, title, stringField(fields, 'body') ?? '', head, base);
      return jsonReply(201, pullJson(repo, pull));
    }
    return errorReply(404, 'Not Found');
  }

  const number = Number(seg[4]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return errorReply(404, 'Not Found');

  if (seg.length === 5) {
    if (input.method === 'GET') return jsonReply(200, pullJson(repo, pull));
    if (input.method === 'PATCH') {
      const body = parseJsonBody(input.body);
      if (body === undefined) return errorReply(400, 'Problems parsing JSON');
      const fields = isRecord(body) ? body : {};
      const title = stringField(fields, 'title');
      if (title !== null && title !== '') pull.title = title;
      const text = stringField(fields, 'body');
      if (text !== null) pull.body = text;
      if (fields.state === 'open' || fields.state === 'closed') pull.state = fields.state;
      pull.updatedAt = forge.nowIso();
      forge.touch();
      return jsonReply(200, pullJson(repo, pull));
    }
    return errorReply(404, 'Not Found');
  }

  if (seg.length === 6 && seg[5] === 'files' && input.method === 'GET') {
    const files = forge.pullDiff(repo, pull).map((file) => ({
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
    }));
    const { pageItems, headers } = paginate(input, files);
    return jsonReply(200, pageItems, headers);
  }

  if (seg.length === 6 && seg[5] === 'merge' && (input.method === 'POST' || input.method === 'PUT')) {
    if (pull.merged || pull.state !== 'open') return errorReply(405, 'Pull Request is not mergeable');
    if (forge.pullConflicts(repo, pull)) return errorReply(405, 'Merge conflict');
    const body = parseJsonBody(input.body);
    const fields = body !== undefined && isRecord(body) ? body : {};
    const sha = forge.mergePull(repo, pull, stringField(fields, 'commit_message') ?? undefined);
    if (sha === null) return errorReply(405, 'Pull Request is not mergeable');
    pull.merged = true;
    pull.mergedAt = forge.nowIso();
    pull.mergeCommitSha = sha;
    pull.state = 'closed';
    pull.updatedAt = pull.mergedAt;
    forge.touch();
    return jsonReply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return errorReply(404, 'Not Found');
}
