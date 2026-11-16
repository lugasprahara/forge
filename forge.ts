// forge.ts -- the forge's state: repositories over one shared object store, their
// labels, issues and pull requests, and the tree surgery the contents API and
// pull merges perform.
//
// Everything lives in memory. Every timestamp the forge stamps derives from
// MAKEFUN_TRIAL_NOW plus a per-process sequence counter -- never from the wall
// clock -- so a trial and its replay stamp byte-identical state.

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

/** The one login the trial token names (the suite's fixed scenario viewer). */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

export const DEFAULT_BRANCH = 'main';

/** MAKEFUN_TRIAL_NOW as milliseconds; a fixed fixture epoch when unset. */
function trialNowMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^\d+$/.test(raw)) return Number(raw);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1_735_689_600_000; // 2025-01-01T00:00:00Z
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
  /** Global REST id; stable for the life of the forge. */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  /** Creation order across the whole forge (a stable sort key). */
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
  /** REST id; also the GraphQL databaseId. */
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

  /** The next deterministic timestamp: the trial's now plus one tick a stamp. */
  nowIso(): string {
    this.seqCounter += 1;
    return new Date(this.baseNowMs + this.seqCounter * 1000).toISOString();
  }

  /** The identity line for forge-authored commits, on the deterministic clock. */
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

  /** A repository answers only to its owner; any other owner reads as absent. */
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

  /** Every repository, oldest first. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------------------
  // refs and branches

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit the default branch points at (through any tag), or null. */
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

  /** Resolve a branch, a full ref, a tag or a raw oid to the commit it names. */
  resolveCommit(repo: Repo, rev: string): string | null {
    let oid: string | null = null;
    if (repo.refs.has(rev)) oid = repo.refs.get(rev)!;
    else if (repo.refs.has(`refs/heads/${rev}`)) oid = repo.refs.get(`refs/heads/${rev}`)!;
    else if (repo.refs.has(`refs/tags/${rev}`)) oid = repo.refs.get(`refs/tags/${rev}`)!;
    else if (this.store.has(rev)) oid = rev;
    return oid === null ? null : peelToCommit(this.store, oid);
  }

  // -------------------------------------------------------------------------
  // reading and writing paths inside a commit's tree

  /** A commit's top-level entries; the empty list for a null commit. */
  treeEntriesOf(commitOid: string | null): TreeEntry[] {
    if (commitOid === null) return [];
    const commit = this.store.commit(commitOid);
    return commit === null ? [] : (this.store.tree(commit.tree) ?? []);
  }

  /** The blob oid at `path` inside a tree (walked segment by segment), or null. */
  blobAtPath(treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((part) => part !== '');
    let tree = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const entries = this.store.tree(tree);
      if (entries === null) return null;
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      if (entry.mode !== '40000') return null;
      tree = entry.oid;
    }
    return null;
  }

  /** Whether `path` names a directory inside the tree. */
  isDirAtPath(treeOid: string, path: string): boolean {
    const segments = path.split('/').filter((part) => part !== '');
    let tree = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const entries = this.store.tree(tree);
      if (entries === null) return false;
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return false;
      if (index === segments.length - 1) return entry.mode === '40000';
      if (entry.mode !== '40000') return false;
      tree = entry.oid;
    }
    return false;
  }

  /** The entries of the directory at `path` ('' is the root), or null. */
  dirEntries(treeOid: string, path: string): TreeEntry[] | null {
    let tree = treeOid;
    if (path !== '') {
      for (const segment of path.split('/').filter((part) => part !== '')) {
        const entries = this.store.tree(tree);
        if (entries === null) return null;
        const entry = entries.find((candidate) => candidate.name === segment);
        if (entry === undefined || entry.mode !== '40000') return null;
        tree = entry.oid;
      }
    }
    return this.store.tree(tree);
  }

  /** Every file path in a tree mapped to its blob oid (the store's cache). */
  flattenTree(treeOid: string): Map<string, string> {
    return this.store.flattenTree(treeOid);
  }

  /**
   * Return the tree that results from putting `blobOid` at `segments` under
   * `treeOid` (a null blob deletes; a null tree starts empty). Intermediate
   * directories that end up empty are pruned, as git trees cannot hold them.
   */
  private writePathIntoTree(treeOid: string | null, segments: string[], blobOid: string | null): string {
    const entries: TreeEntry[] = treeOid === null ? [] : [...(this.store.tree(treeOid) ?? [])];
    const head = segments[0]!;
    const rest = segments.slice(1);
    const at = entries.findIndex((entry) => entry.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { mode: '100644', name: head, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name: head, oid: blobOid });
      }
    } else {
      const existing = at >= 0 ? entries[at] : undefined;
      const subTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
      const newSub = this.writePathIntoTree(subTree, rest, blobOid);
      if ((this.store.tree(newSub) ?? []).length === 0) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { mode: '40000', name: head, oid: newSub };
      } else {
        entries.push({ mode: '40000', name: head, oid: newSub });
      }
    }
    return this.store.add('tree', buildTree(entries));
  }

  /** Commit a one-file change on a branch, creating the branch when needed. */
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
    const newTree = this.writePathIntoTree(
      parentTree,
      path.split('/').filter((part) => part !== ''),
      blobOid,
    );
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
  // issues and pull requests

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

  /** A pull request's head and base tips, read live from the refs. */
  pullTips(repo: Repo, pull: Pull): { head: string | null; base: string | null } {
    return {
      head: this.branchTip(repo, pull.headRef),
      base: this.branchTip(repo, pull.baseRef),
    };
  }

  /** The files a pull changes, diffed from its merge base to its head. */
  pullDiff(repo: Repo, pull: Pull): Array<{ path: string; status: string; additions: number; deletions: number }> {
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return [];
    const headCommit = peelToCommit(this.store, head);
    const baseCommit = peelToCommit(this.store, base);
    if (headCommit === null || baseCommit === null) return [];
    const from = mergeBase(this.store, baseCommit, headCommit) ?? baseCommit;
    const fromTree = this.store.commit(from)?.tree;
    const toTree = this.store.commit(headCommit)?.tree;
    if (fromTree === undefined || toTree === undefined) return [];
    return diffTrees(this.store, fromTree, toTree);
  }

  /** Whether merging `pull` now would conflict (a file-level three-way test). */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return true;
    const headCommit = peelToCommit(this.store, head);
    const baseCommit = peelToCommit(this.store, base);
    if (headCommit === null || baseCommit === null) return true;
    const baseOfMerge = mergeBase(this.store, baseCommit, headCommit);
    if (baseOfMerge === null) return true;
    return (
      threeWayMerge(
        this.store,
        this.store.commit(baseOfMerge)!.tree,
        this.store.commit(baseCommit)!.tree,
        this.store.commit(headCommit)!.tree,
      ) === null
    );
  }

  /**
   * Squash-merge a pull request: a single new commit on the base branch whose
   * tree is the three-way merge of the head into the current base. Returns the
   * new commit's oid, or null when the merge conflicts.
   */
  mergePull(repo: Repo, pull: Pull, message?: string): string | null {
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return null;
    const headCommit = peelToCommit(this.store, head);
    const baseCommit = peelToCommit(this.store, base);
    if (headCommit === null || baseCommit === null) return null;
    if (isAncestor(this.store, headCommit, baseCommit)) {
      // The head is already contained in the base: the base tip is the result.
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

  /** Commits reachable from `tip`, children always before their parents. */
  listCommits(repo: Repo, tip: string): string[] {
    const start = peelToCommit(this.store, tip) ?? (this.store.has(tip) ? tip : null);
    if (start === null) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    let frontier = [start];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        out.push(oid);
        const commit = this.store.commit(oid);
        if (commit !== null) for (const parent of commit.parents) next.push(parent);
      }
      frontier = next;
    }
    return out;
  }

  commitAncestorsOf(tip: string): Set<string> {
    return commitAncestors(this.store, tip);
  }

  /** The object an annotated tag names, or null when `oid` is not a tag. */
  tagTarget(oid: string): string | null {
    const object = this.store.get(oid);
    if (object === undefined || object.type !== 'tag') return null;
    return parseTag(object.data).object;
  }
}

/** Lines in a blob; a trailing line without its newline still counts. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === 0x0a) lines += 1;
  }
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

/**
 * Addition/deletion counts between two texts, from their longest common
 * subsequence of lines. The shared head and tail are trimmed before the
 * quadratic table runs, which keeps the common cases (an append, a small
 * edit) out of the table entirely.
 */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > head && newEnd > head && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const oldMid = oldLines.slice(head, oldEnd);
  const newMid = newLines.slice(head, newEnd);
  if (oldMid.length === 0) return { additions: newMid.length, deletions: 0 };
  if (newMid.length === 0) return { additions: 0, deletions: oldMid.length };
  if (oldMid.length * newMid.length > 4_000_000) {
    return { additions: newMid.length, deletions: oldMid.length };
  }
  const cols = newMid.length + 1;
  const table = new Uint32Array((oldMid.length + 1) * cols);
  for (let i = oldMid.length - 1; i >= 0; i -= 1) {
    for (let j = newMid.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = oldMid[i] === newMid[j]
        ? table[(i + 1) * cols + j + 1]! + 1
        : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const common = table[0]!;
  return { additions: newMid.length - common, deletions: oldMid.length - common };
}

/** The file-level diff between two trees: status and line counts per path. */
export function diffTrees(
  store: ObjectStore,
  fromTree: string,
  toTree: string,
): Array<{ path: string; status: string; additions: number; deletions: number }> {
  const from = store.flattenTree(fromTree);
  const to = store.flattenTree(toTree);
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const out: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  for (const path of paths) {
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
      const diff = lineDiff(
        (store.get(before)?.data ?? Buffer.alloc(0)).toString('utf8'),
        (store.get(after)?.data ?? Buffer.alloc(0)).toString('utf8'),
      );
      out.push({ path, status: 'modified', additions: diff.additions, deletions: diff.deletions });
    }
  }
  return out;
}

/**
 * A file-level three-way merge over flattened trees. Returns the merged
 * tree's oid, or null when both sides changed the same path to different
 * contents (or one side changed a path the other deleted).
 */
export function threeWayMerge(
  store: ObjectStore,
  baseTree: string,
  ourTree: string,
  theirTree: string,
): string | null {
  const base = store.flattenTree(baseTree);
  const ours = store.flattenTree(ourTree);
  const theirs = store.flattenTree(theirTree);
  const merged = new Map<string, string>();
  for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const changedOurs = o !== b;
    const changedTheirs = t !== b;
    if (changedOurs && changedTheirs && o !== t) return null;
    const winner = changedTheirs ? t : o;
    if (winner !== undefined) merged.set(path, winner);
  }
  // Fold the flat winner map back into a hierarchy of tree objects.
  interface DirNode {
    files: Map<string, string>;
    dirs: Map<string, DirNode>;
  }
  const newDir = (): DirNode => ({ files: new Map(), dirs: new Map() });
  const root = newDir();
  for (const [path, oid] of merged) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = newDir();
        node.dirs.set(segment, child);
      }
      node = child;
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
