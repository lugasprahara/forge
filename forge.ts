// forge.ts -- the forge's world: repositories over one shared object store,
// their refs, labels, issues and pull requests, and the tree surgery behind
// the contents API and pull merges.
//
// Everything lives in memory. Two counters keep the HTTP layer's memoization
// honest:
//   * `epoch` moves on every mutation of forge-level state (a repo, issue,
//     pull, label or ref created, changed or deleted), and
//   * the object store counts its own additions.
// A cached answer keyed on both numbers describes exactly the world that
// produced it, and no other.
//
// Every timestamp derives from MAKEFUN_TRIAL_NOW plus a per-process tick --
// never the wall clock -- so a trial and its replay stamp identical state.

import {
  ObjectStore,
  addTreeContents,
  ancestorSet,
  commonAncestor,
  isAncestorOf,
  peelCommit,
  readTag,
  writeCommit,
  writeTree,
  type TreeItem,
} from './gitcore.ts';

/** The one login the trial token names (the suite's fixed scenario viewer). */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

export const HOME_BRANCH = 'main';

/** MAKEFUN_TRIAL_NOW as milliseconds; a fixed fixture epoch when unset. */
function trialEpochMs(): number {
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

export interface Comment {
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
  comments: Comment[];
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
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export class Repo {
  /** Bumped whenever a ref is written or deleted (drives git-HTTP caching). */
  gitVersion = 0;

  readonly id: number;
  readonly owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref name (refs/heads/x, refs/tags/y) -> object id. */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  readonly createdAt: string;
  readonly seq: number;

  constructor(
    id: number,
    owner: string,
    name: string,
    isPrivate: boolean,
    description: string,
    defaultBranch: string,
    refs: Map<string, string>,
    labels: Map<string, Label>,
    issues: Map<number, Issue>,
    pulls: Map<number, Pull>,
    nextNumber: number,
    createdAt: string,
    seq: number,
  ) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.defaultBranch = defaultBranch;
    this.refs = refs;
    this.labels = labels;
    this.issues = issues;
    this.pulls = pulls;
    this.nextNumber = nextNumber;
    this.createdAt = createdAt;
    this.seq = seq;
  }
}

export class Forge {
  readonly store = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  /** Moves on every observable mutation; see the file header. */
  epoch = 0;
  private entityCounter = 10_000;
  private tick = 0;
  readonly epochMs = trialEpochMs();

  /** Mark the world changed: every memoized answer keyed so far is stale. */
  touch(): void {
    this.epoch += 1;
  }

  /** The next deterministic timestamp: the trial's now plus one tick. */
  nowIso(): string {
    this.tick += 1;
    return new Date(this.epochMs + this.tick * 1000).toISOString();
  }

  /** The identity line for forge-authored commits, on the same clock. */
  identity(): { text: string; seconds: number } {
    this.tick += 1;
    const seconds = Math.floor(this.epochMs / 1000) + this.tick;
    return { text: `${VIEWER.name} <${VIEWER.email}> ${seconds} +0000`, seconds };
  }

  nextEntityId(): number {
    this.entityCounter += 1;
    return this.entityCounter;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** A repository answers only to its owner; any other owner reads absent. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo = new Repo(
      this.nextEntityId(),
      VIEWER.login,
      name,
      isPrivate,
      description,
      HOME_BRANCH,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      1,
      this.nowIso(),
      this.tick,
    );
    this.repos.set(this.repoKey(repo.owner, name), repo);
    this.touch();
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    this.touch();
  }

  /** Every repository, oldest first. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------------------
  // refs: every write funnels through here so the version counters move

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.gitVersion += 1;
    this.touch();
  }

  deleteRef(repo: Repo, ref: string): void {
    if (repo.refs.delete(ref)) {
      repo.gitVersion += 1;
      this.touch();
    }
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit the default branch points at (through any tag), or null. */
  headCommit(repo: Repo): string | null {
    const tip = this.branchTip(repo, repo.defaultBranch);
    return tip === null ? null : peelCommit(this.store, tip);
  }

  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** Resolve a branch, a full ref, a tag or a raw oid to its commit. */
  resolveCommit(repo: Repo, rev: string): string | null {
    let oid: string | null = null;
    if (repo.refs.has(rev)) oid = repo.refs.get(rev)!;
    else if (repo.refs.has(`refs/heads/${rev}`)) oid = repo.refs.get(`refs/heads/${rev}`)!;
    else if (repo.refs.has(`refs/tags/${rev}`)) oid = repo.refs.get(`refs/tags/${rev}`)!;
    else if (this.store.has(rev)) oid = rev;
    return oid === null ? null : peelCommit(this.store, oid);
  }

  // -------------------------------------------------------------------------
  // paths inside trees

  /** A commit's top-level entries; the empty list for a null commit. */
  topEntries(commitOid: string | null): TreeItem[] {
    if (commitOid === null) return [];
    const commit = this.store.commit(commitOid);
    return commit === null ? [] : (this.store.tree(commit.tree) ?? []);
  }

  private entryAt(treeOid: string, path: string): TreeItem | null {
    const segments = path.split('/').filter((part) => part !== '');
    let tree = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const items = this.store.tree(tree);
      if (items === null) return null;
      const item = items.find((candidate) => candidate.name === segments[index]);
      if (item === undefined) return null;
      if (index === segments.length - 1) return item;
      if (item.mode !== '40000') return null;
      tree = item.oid;
    }
    return null;
  }

  /** The blob oid at `path` inside a tree, or null. */
  blobAt(treeOid: string, path: string): string | null {
    const item = this.entryAt(treeOid, path);
    return item === null || item.mode === '40000' ? null : item.oid;
  }

  /** Whether `path` names a directory inside the tree. */
  isDirAt(treeOid: string, path: string): boolean {
    const item = this.entryAt(treeOid, path);
    return item !== null && item.mode === '40000';
  }

  /** The entries of the directory at `path` ('' is the root), or null. */
  dirEntries(treeOid: string, path: string): TreeItem[] | null {
    if (path === '') return this.store.tree(treeOid);
    const item = this.entryAt(treeOid, path);
    return item === null || item.mode !== '40000' ? null : this.store.tree(item.oid);
  }

  /**
   * The tree that results from putting `blobOid` at `segments` under
   * `treeOid` (a null blob deletes; a null tree starts empty). Directories
   * left empty are pruned, as git trees cannot hold them.
   */
  private placeInTree(treeOid: string | null, segments: string[], blobOid: string | null): string {
    const items: TreeItem[] = treeOid === null ? [] : [...(this.store.tree(treeOid) ?? [])];
    const head = segments[0]!;
    const rest = segments.slice(1);
    const at = items.findIndex((item) => item.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (at >= 0) items.splice(at, 1);
      } else if (at >= 0) {
        items[at] = { mode: '100644', name: head, oid: blobOid };
      } else {
        items.push({ mode: '100644', name: head, oid: blobOid });
      }
    } else {
      const existing = at >= 0 ? items[at] : undefined;
      const subTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
      const newSub = this.placeInTree(subTree, rest, blobOid);
      if ((this.store.tree(newSub) ?? []).length === 0) {
        if (at >= 0) items.splice(at, 1);
      } else if (at >= 0) {
        items[at] = { mode: '40000', name: head, oid: newSub };
      } else {
        items.push({ mode: '40000', name: head, oid: newSub });
      }
    }
    return this.store.add('tree', writeTree(items));
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
    const parentCommit = parentTip === null ? null : peelCommit(this.store, parentTip);
    const parentTree = parentCommit === null ? null : this.store.commit(parentCommit)!.tree;
    const newTree = this.placeInTree(
      parentTree,
      path.split('/').filter((part) => part !== ''),
      blobOid,
    );
    const identity = this.identity();
    const commitOid = this.store.add(
      'commit',
      writeCommit({
        tree: newTree,
        parents: parentCommit === null ? [] : [parentCommit],
        // Stored verbatim: the REST commits view echoes the message exactly
        // as the writer sent it, trailing newline or none.
        message,
        author: identity.text,
        committer: identity.text,
      }),
    );
    this.setRef(repo, `refs/heads/${branch}`, commitOid);
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
      seq: this.tick,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    this.touch();
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
      seq: this.tick,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    this.touch();
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
  pullDiff(repo: Repo, pull: Pull): FileChange[] {
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return [];
    const headCommit = peelCommit(this.store, head);
    const baseCommit = peelCommit(this.store, base);
    if (headCommit === null || baseCommit === null) return [];
    const from = commonAncestor(this.store, baseCommit, headCommit) ?? baseCommit;
    const fromTree = this.store.commit(from)?.tree;
    const toTree = this.store.commit(headCommit)?.tree;
    if (fromTree === undefined || toTree === undefined) return [];
    return diffTrees(this.store, fromTree, toTree);
  }

  /** Whether merging `pull` now would conflict (a file-level three-way test). */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const tips = this.pullMergeCommits(repo, pull);
    if (tips === null) return true;
    return (
      threeWayMerge(
        this.store,
        this.store.commit(tips.baseOfMerge)!.tree,
        this.store.commit(tips.baseCommit)!.tree,
        this.store.commit(tips.headCommit)!.tree,
      ) === null
    );
  }

  /** The three commits a merge works from, or null when it cannot start. */
  private pullMergeCommits(
    repo: Repo,
    pull: Pull,
  ): { headCommit: string; baseCommit: string; baseOfMerge: string } | null {
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return null;
    const headCommit = peelCommit(this.store, head);
    const baseCommit = peelCommit(this.store, base);
    if (headCommit === null || baseCommit === null) return null;
    const baseOfMerge = commonAncestor(this.store, baseCommit, headCommit);
    if (baseOfMerge === null) return null;
    return { headCommit, baseCommit, baseOfMerge };
  }

  /**
   * Squash-merge a pull request: one new commit on the base branch whose
   * tree is the three-way merge of the head into the current base. Returns
   * the new commit's oid, or null when the merge conflicts.
   */
  mergePull(repo: Repo, pull: Pull, message?: string): string | null {
    const tips = this.pullMergeCommits(repo, pull);
    if (tips === null) return null;
    if (isAncestorOf(this.store, tips.headCommit, tips.baseCommit)) {
      // The head is already contained in the base: the base tip is the result.
      return tips.baseCommit;
    }
    const mergedTree = threeWayMerge(
      this.store,
      this.store.commit(tips.baseOfMerge)!.tree,
      this.store.commit(tips.baseCommit)!.tree,
      this.store.commit(tips.headCommit)!.tree,
    );
    if (mergedTree === null) return null;
    const identity = this.identity();
    const commitOid = this.store.add(
      'commit',
      writeCommit({
        tree: mergedTree,
        parents: [tips.baseCommit],
        message: message ?? `${pull.title} (#${pull.number})\n`,
        author: identity.text,
        committer: identity.text,
      }),
    );
    this.setRef(repo, `refs/heads/${pull.baseRef}`, commitOid);
    return commitOid;
  }

  /** Commits reachable from `tip`, children always before their parents. */
  listCommits(tip: string): string[] {
    const start = peelCommit(this.store, tip) ?? (this.store.has(tip) ? tip : null);
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
    return ancestorSet(this.store, tip);
  }

  /** The object an annotated tag names, or null when `oid` is not a tag. */
  tagTarget(oid: string): string | null {
    const object = this.store.get(oid);
    if (object === undefined || object.type !== 'tag') return null;
    return readTag(object.data).object;
  }

  /** A tree plus everything beneath it, for reachability walks. */
  addTreeContents(treeOid: string, into: Set<string>): void {
    addTreeContents(this.store, treeOid, into);
  }
}

// ---------------------------------------------------------------------------
// diffs and merges over flattened trees

export interface FileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
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
 * Addition/deletion counts between two texts, from the longest common
 * subsequence of their lines. The shared head and tail are trimmed before
 * the quadratic table runs, keeping the common cases (an append, a small
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
export function diffTrees(store: ObjectStore, fromTree: string, toTree: string): FileChange[] {
  const from = store.flatten(fromTree);
  const to = store.flatten(toTree);
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const out: FileChange[] = [];
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
  const base = store.flatten(baseTree);
  const ours = store.flatten(ourTree);
  const theirs = store.flatten(theirTree);
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
    const items: TreeItem[] = [];
    for (const [name, oid] of node.files) items.push({ mode: '100644', name, oid });
    for (const [name, sub] of node.dirs) items.push({ mode: '40000', name, oid: build(sub) });
    return store.add('tree', writeTree(items));
  };
  return build(root);
}
