// The forge's state and domain operations: users, repositories (refs over the shared
// object store), labels, issues, comments and pull requests, plus the tree/commit
// surgery the contents API and merges need. Everything is in memory; every timestamp
// derives from MAKEFUN_TRIAL_NOW plus a per-process sequence, so a replayed trial
// produces byte-identical exports.

import {
  ObjectStore,
  ZERO_OID,
  buildCommit,
  buildTree,
  commitAncestors,
  isAncestor,
  mergeBase,
  parseTag,
  peelToCommit,
  type TreeEntry,
} from './gitcore.ts';

/** The one login the trial token names (wire.ts's fixed scenario viewer). */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

export const DEFAULT_BRANCH = 'main';

function trialNowMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^\d+$/.test(raw)) return Number(raw);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1_735_689_600_000; // 2025-01-01T00:00:00Z, the fixture epoch, as a safe default
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  /** REST id (global, stable). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  /** Creation order within the forge (for stable sorting). */
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  /** REST id / GraphQL databaseId. */
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref name (refs/heads/x, refs/tags/y) -> object id. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  createdAt: string;
  seq: number;
}

export class Forge {
  readonly store = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  private entityCounter = 10_000;
  private seqCounter = 0;
  readonly baseNowMs = trialNowMs();

  /** The next deterministic timestamp: base now + a monotonic per-event increment. */
  nowIso(): string {
    this.seqCounter += 1;
    return new Date(this.baseNowMs + this.seqCounter * 1000).toISOString();
  }

  /** An identity line for forge-authored commits, stamped with the deterministic clock. */
  forgeIdentity(): { text: string; timestamp: number } {
    this.seqCounter += 1;
    const seconds = Math.floor(this.baseNowMs / 1000) + this.seqCounter;
    return { text: `${VIEWER.name} <${VIEWER.email}> ${seconds} +0000`, timestamp: seconds };
  }

  nextEntityId(): number {
    this.entityCounter += 1;
    return this.entityCounter;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** A repository is visible only to its owner; anything else is a 404 upstream. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextEntityId(),
      owner: VIEWER.login,
      name,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: this.nowIso(),
      seq: this.seqCounter,
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------------------
  // refs and branches

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit HEAD resolves to (through the default branch), or null when unborn. */
  headCommit(repo: Repo): string | null {
    const tip = this.branchTip(repo, repo.defaultBranch);
    return tip === null ? null : peelToCommit(this.store, tip);
  }

  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** Resolve a branch name, a full ref, a tag name or an oid to a commit oid. */
  resolveCommit(repo: Repo, rev: string): string | null {
    let oid: string | null = null;
    if (repo.refs.has(rev)) oid = repo.refs.get(rev)!;
    else if (repo.refs.has(`refs/heads/${rev}`)) oid = repo.refs.get(`refs/heads/${rev}`)!;
    else if (repo.refs.has(`refs/tags/${rev}`)) oid = repo.refs.get(`refs/tags/${rev}`)!;
    else if (this.store.has(rev)) oid = rev;
    if (oid === null) return null;
    return peelToCommit(this.store, oid);
  }

  // -------------------------------------------------------------------------
  // tree surgery: read/write a file path inside a commit's tree

  /** The tree entries of a commit, or of the empty tree for a null commit. */
  treeEntriesOf(commitOid: string | null): TreeEntry[] {
    if (commitOid === null) return [];
    const commit = this.store.commit(commitOid);
    if (!commit) return [];
    return this.store.tree(commit.tree) ?? [];
  }

  /** Read a file's blob oid at `path` inside a tree (recursive), or null. */
  blobAtPath(treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((part) => part !== '');
    let currentTree = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const entries = this.store.tree(currentTree);
      if (!entries) return null;
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      if (entry.mode !== '40000') return null;
      currentTree = entry.oid;
    }
    return null;
  }

  /** Whether `path` is a directory inside the tree. */
  isDirAtPath(treeOid: string, path: string): boolean {
    const segments = path.split('/').filter((part) => part !== '');
    let currentTree = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const entries = this.store.tree(currentTree);
      if (!entries) return false;
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (!entry) return false;
      if (index === segments.length - 1) return entry.mode === '40000';
      if (entry.mode !== '40000') return false;
      currentTree = entry.oid;
    }
    return false;
  }

  /** The entries of the directory at `path` ('' = root), or null when not a directory. */
  dirEntries(treeOid: string, path: string): TreeEntry[] | null {
    if (path === '') return this.store.tree(treeOid);
    const segments = path.split('/').filter((part) => part !== '');
    let currentTree = treeOid;
    for (const segment of segments) {
      const entries = this.store.tree(currentTree);
      if (!entries) return null;
      const entry = entries.find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      currentTree = entry.oid;
    }
    return this.store.tree(currentTree);
  }

  /** A flat map of every file path in a tree to its blob oid. */
  flattenTree(treeOid: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, base: string): void => {
      const entries = this.store.tree(oid);
      if (!entries) return;
      for (const entry of entries) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, entry.oid);
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Write `blobOid` at `path` in the tree, returning the new tree oid. */
  private writePathIntoTree(treeOid: string | null, segments: string[], blobOid: string | null): string {
    const entries: TreeEntry[] = treeOid === null ? [] : [...(this.store.tree(treeOid) ?? [])];
    const [head, ...rest] = segments as [string, ...string[]];
    const existingIndex = entries.findIndex((entry) => entry.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (existingIndex >= 0) entries.splice(existingIndex, 1);
      } else {
        const entry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
        if (existingIndex >= 0) entries[existingIndex] = entry;
        else entries.push(entry);
      }
    } else {
      const existing = existingIndex >= 0 ? entries[existingIndex] : undefined;
      const subTree = existing && existing.mode === '40000' ? existing.oid : null;
      const newSub = this.writePathIntoTree(subTree, rest, blobOid);
      const subEntries = this.store.tree(newSub) ?? [];
      if (subEntries.length === 0) {
        if (existingIndex >= 0) entries.splice(existingIndex, 1);
      } else {
        const entry: TreeEntry = { mode: '40000', name: head, oid: newSub };
        if (existingIndex >= 0) entries[existingIndex] = entry;
        else entries.push(entry);
      }
    }
    return this.store.add('tree', buildTree(entries));
  }

  /** Commit a one-file change on a branch (creating the branch/ref as needed). */
  commitFileChange(
    repo: Repo,
    branch: string,
    path: string,
    blobOid: string | null,
    message: string,
  ): { commitOid: string; treeOid: string } {
    const parentTip = this.branchTip(repo, branch) ?? this.branchTip(repo, repo.defaultBranch);
    const parentCommit = parentTip === null ? null : peelToCommit(this.store, parentTip);
    const parentTree = parentCommit === null ? null : this.store.commit(parentCommit)!.tree;
    const segments = path.split('/').filter((part) => part !== '');
    const newTree = this.writePathIntoTree(parentTree, segments, blobOid);
    const identity = this.forgeIdentity();
    const commitOid = this.store.add(
      'commit',
      buildCommit({
        tree: newTree,
        parents: parentCommit === null ? [] : [parentCommit],
        message: message.endsWith('\n') ? message : `${message}\n`,
        author: identity.text,
        committer: identity.text,
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid, treeOid: newTree };
  }

  // -------------------------------------------------------------------------
  // issues and pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const stamp = this.nowIso();
    const issue: Issue = {
      id: this.nextEntityId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
      seq: this.seqCounter,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const stamp = this.nowIso();
    const pull: Pull = {
      id: this.nextEntityId(),
      number: repo.nextNumber,
      title,
      body,
      headRef,
      baseRef,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
      seq: this.seqCounter,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The current head/base commit oids of a pull request (live from the refs). */
  pullTips(repo: Repo, pull: Pull): { head: string | null; base: string | null } {
    return {
      head: this.branchTip(repo, pull.headRef),
      base: this.branchTip(repo, pull.baseRef),
    };
  }

  /** The changed files between the merge base of head/base and the head tip. */
  pullDiff(repo: Repo, pull: Pull): Array<{ path: string; status: string; additions: number; deletions: number }> {
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return [];
    const headCommit = peelToCommit(this.store, head);
    const baseCommit = peelToCommit(this.store, base);
    if (headCommit === null || baseCommit === null) return [];
    const baseOfMerge = mergeBase(this.store, baseCommit, headCommit) ?? baseCommit;
    const fromTree = this.store.commit(baseOfMerge)?.tree;
    const toTree = this.store.commit(headCommit)?.tree;
    if (!fromTree || !toTree) return [];
    return diffTrees(this.store, fromTree, toTree);
  }

  /** Whether merging `pull` right now would conflict (file-level three-way test). */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return true;
    const headCommit = peelToCommit(this.store, head);
    const baseCommit = peelToCommit(this.store, base);
    if (headCommit === null || baseCommit === null) return true;
    const baseOfMerge = mergeBase(this.store, baseCommit, headCommit);
    if (baseOfMerge === null) return true;
    const merged = threeWayMerge(
      this.store,
      this.store.commit(baseOfMerge)!.tree,
      this.store.commit(baseCommit)!.tree,
      this.store.commit(headCommit)!.tree,
    );
    return merged === null;
  }

  /**
   * Squash-merge a pull request: one new commit on the base branch whose tree is the
   * three-way merge of the head into the current base. Returns the new commit oid, or
   * null when the merge conflicts.
   */
  mergePull(repo: Repo, pull: Pull, message?: string): string | null {
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return null;
    const headCommit = peelToCommit(this.store, head);
    const baseCommit = peelToCommit(this.store, base);
    if (headCommit === null || baseCommit === null) return null;
    if (isAncestor(this.store, headCommit, baseCommit)) {
      // Already up to date: the squash commit is the base tip itself.
      return baseCommit;
    }
    const baseOfMerge = mergeBase(this.store, baseCommit, headCommit);
    if (baseOfMerge === null) return null;
    const mergedTree = threeWayMerge(
      this.store,
      this.store.commit(baseOfMerge)!.tree,
      this.store.commit(baseCommit)!.tree,
      this.store.commit(headCommit)!.tree,
    );
    if (mergedTree === null) return null;
    const identity = this.forgeIdentity();
    const commitOid = this.store.add(
      'commit',
      buildCommit({
        tree: mergedTree,
        parents: [baseCommit],
        message: message ?? `${pull.title} (#${pull.number})\n`,
        author: identity.text,
        committer: identity.text,
      }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    return commitOid;
  }

  /** Commits reachable from `tip`, newest first (by ancestry walk order). */
  listCommits(repo: Repo, tip: string): string[] {
    const start = peelToCommit(this.store, tip) ?? (this.store.has(tip) ? tip : null);
    if (start === null) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    // Walk generation by generation so parents never precede their children.
    let frontier = [start];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        out.push(oid);
        const commit = this.store.commit(oid);
        if (commit) for (const parent of commit.parents) next.push(parent);
      }
      frontier = next;
    }
    return out;
  }

  commitAncestorsOf(tip: string): Set<string> {
    return commitAncestors(this.store, tip);
  }

  tagTarget(oid: string): string | null {
    const object = this.store.get(oid);
    if (!object || object.type !== 'tag') return null;
    return parseTag(object.data).object;
  }
}

/** Line counts for a blob (a final line without a newline still counts). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < data.length; index += 1) if (data[index] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** A small LCS line diff: {additions, deletions} between two texts. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * cols + j + 1]! + 1
        : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const common = table[0]!;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** The file-level diff between two trees. */
export function diffTrees(
  store: ObjectStore,
  fromTree: string,
  toTree: string,
): Array<{ path: string; status: string; additions: number; deletions: number }> {
  const forge = new ForgeTreeWalk(store);
  const from = forge.flatten(fromTree);
  const to = forge.flatten(toTree);
  const paths = new Set([...from.keys(), ...to.keys()]);
  const out: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before === after) continue;
    if (before === undefined) {
      const data = store.get(after!)?.data ?? Buffer.alloc(0);
      out.push({ path, status: 'added', additions: countLines(data), deletions: 0 });
    } else if (after === undefined) {
      const data = store.get(before)?.data ?? Buffer.alloc(0);
      out.push({ path, status: 'removed', additions: 0, deletions: countLines(data) });
    } else {
      const oldData = store.get(before)?.data ?? Buffer.alloc(0);
      const newData = store.get(after)?.data ?? Buffer.alloc(0);
      const diff = lineDiff(oldData.toString('utf8'), newData.toString('utf8'));
      out.push({ path, status: 'modified', additions: diff.additions, deletions: diff.deletions });
    }
  }
  return out;
}

/** Helper so diffTrees can flatten without a full Forge instance. */
class ForgeTreeWalk {
  private readonly store: ObjectStore;

  constructor(store: ObjectStore) {
    this.store = store;
  }

  flatten(treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, base: string): void => {
      const entries = this.store.tree(oid);
      if (!entries) return;
      for (const entry of entries) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }
}

/**
 * File-level three-way merge of flattened trees. Returns the merged tree oid, or null
 * when both sides changed the same path to different contents.
 */
export function threeWayMerge(
  store: ObjectStore,
  baseTree: string,
  ourTree: string,
  theirTree: string,
): string | null {
  const walk = new ForgeTreeWalk(store);
  const base = walk.flatten(baseTree);
  const ours = walk.flatten(ourTree);
  const theirs = walk.flatten(theirTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, string>();
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const changedOurs = o !== b;
    const changedTheirs = t !== b;
    if (changedOurs && changedTheirs && o !== t) return null;
    const winner = changedTheirs ? t : o;
    if (winner !== undefined) merged.set(path, winner);
  }
  // Rebuild the tree hierarchy from the flat map.
  interface DirNode {
    files: Map<string, string>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of merged) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      if (!node.dirs.has(segment)) node.dirs.set(segment, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(segment)!;
    }
    node.files.set(segments[segments.length - 1]!, oid);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return store.add('tree', buildTree(entries));
  };
  return build(root);
}

export { ZERO_OID };
