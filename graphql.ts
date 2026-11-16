// graphql.ts -- the GraphQL v4 surface at POST /api/graphql.
//
// A hand-written tokenizer and parser cover the documents gh and
// github-mcp-server send: operations with variables, aliases, fragments and
// inline fragments, input objects, enum lists, and batched operations. A
// small schema table drives execution over the forge store and answers
// __type introspection. Unknown fields come back as GraphQL errors inside a
// 200 body, never as HTTP errors; an unknown repository is data.repository
// null with no errors at all.

import { VIEWER, type Forge, type Issue, type Pull, type Repo } from './forge.ts';
import { isRecord } from './webutil.ts';

// ---------------------------------------------------------------------------
// global ids and cursors: opaque base64, stable across reads

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64');
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64');
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64');
}

export function commentGlobalId(id: number): string {
  return Buffer.from(`IssueComment:${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const parts = Buffer.from(id, 'base64').toString('utf8').split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { type: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function offsetOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  return match === null ? -1 : Number(match[1]);
}

// ---------------------------------------------------------------------------
// tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  let at = 0;
  while (at < source.length) {
    const ch = source[at]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'spread' });
      at += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        tokens.push({ kind: 'string', value: source.slice(at + 3, end < 0 ? source.length : end) });
        at = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\' && at + 1 < source.length) {
          const esc = source[at + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(at + 2, at + 6), 16));
            at += 4;
          } else value += esc;
          at += 2;
        } else {
          value += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      let end = at;
      while (end < source.length && isNameChar(source[end]!)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(at, end) });
      at = end;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = at;
      while (end < source.length && /[0-9.eE+-]/.test(source[end]!)) end += 1;
      const text = source.slice(at, end);
      if (/[.eE]/.test(text)) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: parseInt(text, 10) });
      at = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private take(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (!this.atPunct(value)) return false;
    this.pos += 1;
    return true;
  }

  private expectPunct(value: string): void {
    const token = this.take();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document`);
    }
  }

  private expectName(): string {
    const token = this.take();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition in GraphQL document');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.take();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.expectName();
        if (this.eatPunct('(')) this.skipBalanced('(', ')');
        this.skipDirectives();
        operations.push({
          operation: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.take();
        const fragName = this.expectName();
        const on = this.take();
        if (on.kind !== 'name' || on.value !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName();
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition "${token.value}" in GraphQL document`);
    }
    return { operations, fragments };
  }

  /** Skip a balanced run; the opening token is already consumed. */
  private skipBalanced(open: string, close: string): void {
    let depth = 1;
    while (this.pos < this.tokens.length && depth > 0) {
      const token = this.take();
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.take();
      this.expectName();
      if (this.eatPunct('(')) this.skipBalanced('(', ')');
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek()?.kind === 'spread') {
      this.take();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.take();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.eatPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.eatPunct('(')) {
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.take();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

/** Materialise a parsed value against the operation's variables. */
function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// the schema the suite introspects: field lists and enum values per type

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'user', 'organization', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'createdAt', 'updatedAt', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'description', 'isPrivate', 'isFork', 'isArchived', 'url', 'createdAt', 'updatedAt',
    'stargazerCount', 'forkCount', 'primaryLanguage', 'ref', 'refs', 'object', 'collaborators',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'author', 'repository', 'labels',
    'comments', 'createdAt', 'updatedAt', 'closedAt', 'locked', 'milestone', 'assignees',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'commits', 'author', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'additions', 'deletions', 'changedFiles',
    'mergeCommit', 'comments', 'reviews',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'author', 'committer', 'committedDate', 'tree'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// ---------------------------------------------------------------------------
// wrapped values: the executor's view of store objects

type Wrapped =
  | { kind: 'user' }
  | { kind: 'repo'; repo: Repo }
  | { kind: 'issue'; repo: Repo; issue: Issue }
  | { kind: 'pull'; repo: Repo; pull: Pull }
  | { kind: 'comment'; repo: Repo; comment: { id: number; body: string; createdAt: string } }
  | { kind: 'ref'; repo: Repo; name: string }
  | { kind: 'connection'; typeName: string; edgeTypeName: string; items: Wrapped[]; total: number; start: number }
  | { kind: 'edge'; typeName: string; node: Wrapped; cursor: string | null }
  | { kind: 'pageInfo'; hasNext: boolean; hasPrevious: boolean; startCursor: string | null; endCursor: string | null }
  | { kind: 'changedFile'; path: string; additions: number; deletions: number; status: string }
  | { kind: 'payload'; typeName: string; value: Wrapped | null }
  | { kind: 'typeInfo'; name: string }
  | { kind: 'fieldInfo'; name: string }
  | { kind: 'enumInfo'; name: string };

function typeNameOf(value: Wrapped): string {
  switch (value.kind) {
    case 'user':
      return 'User';
    case 'repo':
      return 'Repository';
    case 'issue':
      return 'Issue';
    case 'pull':
      return 'PullRequest';
    case 'comment':
      return 'IssueComment';
    case 'ref':
      return 'Ref';
    case 'connection':
      return value.typeName;
    case 'edge':
      return value.typeName;
    case 'pageInfo':
      return 'PageInfo';
    case 'changedFile':
      return 'PullRequestChangedFile';
    case 'payload':
      return value.typeName;
    case 'typeInfo':
      return '__Type';
    case 'fieldInfo':
      return '__Field';
    case 'enumInfo':
      return '__EnumValue';
  }
}

const WRAPPED_KINDS = new Set([
  'user', 'repo', 'issue', 'pull', 'comment', 'ref', 'connection', 'edge',
  'pageInfo', 'changedFile', 'payload', 'typeInfo', 'fieldInfo', 'enumInfo',
]);

function isWrapped(value: unknown): value is Wrapped {
  return isRecord(value) && typeof value.kind === 'string' && WRAPPED_KINDS.has(value.kind);
}

function repoByDbId(forge: Forge, dbId: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

/** Resolve a global id (Relay's node field) back to the object it names. */
function resolveNode(forge: Forge, id: string): Wrapped | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = repoByDbId(forge, Number(decoded.parts[0]));
    return repo === null ? null : { kind: 'repo', repo };
  }
  if (decoded.type === 'Issue') {
    const repo = repoByDbId(forge, Number(decoded.parts[0]));
    const issue = repo?.issues.get(Number(decoded.parts[1]));
    return repo !== null && repo !== undefined && issue !== undefined ? { kind: 'issue', repo, issue } : null;
  }
  if (decoded.type === 'PullRequest') {
    const repo = repoByDbId(forge, Number(decoded.parts[0]));
    const pull = repo?.pulls.get(Number(decoded.parts[1]));
    return repo !== null && repo !== undefined && pull !== undefined ? { kind: 'pull', repo, pull } : null;
  }
  if (decoded.type === 'User') return { kind: 'user' };
  return null;
}

/** Slice a connection window out of `items` by the first/after arguments. */
function makeConnection(
  typeName: string,
  edgeTypeName: string,
  items: Wrapped[],
  first: unknown,
  after: unknown,
): Wrapped {
  const start = after === null || after === undefined ? 0 : offsetOfCursor(after) + 1;
  const count = typeof first === 'number' ? Math.max(0, first) : items.length;
  return {
    kind: 'connection',
    typeName,
    edgeTypeName,
    items: items.slice(start, start + count),
    total: items.length,
    start,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------------------
// resolvers

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

type Resolver = (ctx: Ctx, source: Wrapped | null, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ kind: 'user' }) as Wrapped,
    repository: (ctx, _source, args) => {
      const repo = ctx.forge.getRepo(
        typeof args.owner === 'string' ? args.owner : '',
        typeof args.name === 'string' ? args.name : '',
      );
      return repo === null ? null : ({ kind: 'repo', repo }) as Wrapped;
    },
    node: (ctx, _source, args) => (typeof args.id === 'string' ? resolveNode(ctx.forge, args.id) : null),
    nodes: (ctx, _source, args) => {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      return ids.map((id) => (typeof id === 'string' ? resolveNode(ctx.forge, id) : null));
    },
    user: (_ctx, _source, args) => (args.login === VIEWER.login ? ({ kind: 'user' }) as Wrapped : null),
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.type === 'Repository'
        ? repoByDbId(ctx.forge, Number(decoded.parts[0]))
        : null;
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve the repository for createIssue' });
        return { kind: 'payload', typeName: 'CreateIssuePayload', value: null } as Wrapped;
      }
      const issue = ctx.forge.createIssue(
        repo,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        [],
      );
      return { kind: 'payload', typeName: 'CreateIssuePayload', value: { kind: 'issue', repo, issue } } as Wrapped;
    },
    closeIssue: (ctx, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const node = typeof input.issueId === 'string' ? resolveNode(ctx.forge, input.issueId) : null;
      if (node === null || node.kind !== 'issue') {
        ctx.errors.push({ message: 'Could not resolve the issue for closeIssue' });
        return { kind: 'payload', typeName: 'CloseIssuePayload', value: null } as Wrapped;
      }
      node.issue.state = 'closed';
      node.issue.updatedAt = ctx.forge.nowIso();
      return { kind: 'payload', typeName: 'CloseIssuePayload', value: node } as Wrapped;
    },
    createPullRequest: (ctx, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.type === 'Repository'
        ? repoByDbId(ctx.forge, Number(decoded.parts[0]))
        : null;
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (repo === null || ctx.forge.branchTip(repo, head) === null || ctx.forge.branchTip(repo, base) === null) {
        ctx.errors.push({ message: 'Could not create the pull request: a branch does not exist' });
        return { kind: 'payload', typeName: 'CreatePullRequestPayload', value: null } as Wrapped;
      }
      const pull = ctx.forge.createPull(
        repo,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        head,
        base,
      );
      return { kind: 'payload', typeName: 'CreatePullRequestPayload', value: { kind: 'pull', repo, pull } } as Wrapped;
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const node = typeof input.pullRequestId === 'string' ? resolveNode(ctx.forge, input.pullRequestId) : null;
      if (node === null || node.kind !== 'pull') {
        ctx.errors.push({ message: 'Could not resolve the pull request for mergePullRequest' });
        return { kind: 'payload', typeName: 'MergePullRequestPayload', value: null } as Wrapped;
      }
      if (!node.pull.merged) {
        const sha = ctx.forge.mergePull(node.repo, node.pull);
        if (sha === null) {
          ctx.errors.push({ message: 'The pull request is not mergeable' });
          return { kind: 'payload', typeName: 'MergePullRequestPayload', value: null } as Wrapped;
        }
        node.pull.merged = true;
        node.pull.state = 'closed';
        node.pull.mergedAt = ctx.forge.nowIso();
        node.pull.mergeCommitSha = sha;
        node.pull.updatedAt = node.pull.mergedAt;
      }
      return { kind: 'payload', typeName: 'MergePullRequestPayload', value: node } as Wrapped;
    },
    addComment: (ctx, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const node = typeof input.subjectId === 'string' ? resolveNode(ctx.forge, input.subjectId) : null;
      if (node === null || (node.kind !== 'issue' && node.kind !== 'pull')) {
        ctx.errors.push({ message: 'Could not resolve the subject for addComment' });
        return { kind: 'payload', typeName: 'AddCommentPayload', value: null } as Wrapped;
      }
      const comment = {
        id: ctx.forge.nextEntityId(),
        body: typeof input.body === 'string' ? input.body : '',
        createdAt: ctx.forge.nowIso(),
      };
      if (node.kind === 'issue') node.issue.comments.push(comment);
      else node.pull.comments.push(comment);
      const edge: Wrapped = { kind: 'edge', typeName: 'CommentEdge', node: { kind: 'comment', repo: node.repo, comment }, cursor: null };
      return { kind: 'payload', typeName: 'AddCommentPayload', value: edge } as Wrapped;
    },
  },
  User: {
    id: () => Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64'),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (_ctx, source) => repoGlobalId((source as { repo: Repo }).repo),
    databaseId: (_ctx, source) => (source as { repo: Repo }).repo.id,
    name: (_ctx, source) => (source as { repo: Repo }).repo.name,
    nameWithOwner: (_ctx, source) => {
      const repo = (source as { repo: Repo }).repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: () => ({ kind: 'user' }) as Wrapped,
    description: (_ctx, source) => (source as { repo: Repo }).repo.description,
    isPrivate: (_ctx, source) => (source as { repo: Repo }).repo.isPrivate,
    createdAt: (_ctx, source) => (source as { repo: Repo }).repo.createdAt,
    updatedAt: (_ctx, source) => (source as { repo: Repo }).repo.createdAt,
    defaultBranchRef: (ctx, source) => {
      const repo = (source as { repo: Repo }).repo;
      if (ctx.forge.branchTip(repo, repo.defaultBranch) === null) return null;
      return { kind: 'ref', repo, name: repo.defaultBranch } as Wrapped;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => false,
    hasWikiEnabled: () => false,
    issue: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : ({ kind: 'issue', repo, issue }) as Wrapped;
    },
    issues: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      let items = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null && states.length > 0) {
        items = items.filter((issue) => states.includes(issueState(issue)));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
      const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
      const ascending = (typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC') === 'ASC';
      items.sort((a, b) => {
        const key = field === 'COMMENTS' ? a.comments.length - b.comments.length : a.seq - b.seq;
        return ascending ? key : -key;
      });
      return makeConnection(
        'IssueConnection',
        'IssueEdge',
        items.map((issue) => ({ kind: 'issue', repo, issue }) as Wrapped),
        args.first,
        args.after,
      );
    },
    pullRequest: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : ({ kind: 'pull', repo, pull }) as Wrapped;
    },
    pullRequests: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      let items = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null && states.length > 0) {
        items = items.filter((pull) => states.includes(pullState(pull)));
      }
      items.sort((a, b) => b.seq - a.seq);
      return makeConnection(
        'PullRequestConnection',
        'PullRequestEdge',
        items.map((pull) => ({ kind: 'pull', repo, pull }) as Wrapped),
        args.first,
        args.after,
      );
    },
  },
  Issue: {
    id: (_ctx, source) => {
      const wrapped = source as { repo: Repo; issue: Issue };
      return issueGlobalId(wrapped.repo, wrapped.issue);
    },
    number: (_ctx, source) => (source as { issue: Issue }).issue.number,
    title: (_ctx, source) => (source as { issue: Issue }).issue.title,
    body: (_ctx, source) => (source as { issue: Issue }).issue.body,
    state: (_ctx, source) => issueState((source as { issue: Issue }).issue),
    createdAt: (_ctx, source) => (source as { issue: Issue }).issue.createdAt,
    updatedAt: (_ctx, source) => (source as { issue: Issue }).issue.updatedAt,
    closedAt: (_ctx, source) => {
      const issue = (source as { issue: Issue }).issue;
      return issue.state === 'closed' ? issue.updatedAt : null;
    },
    repository: (_ctx, source) => ({ kind: 'repo', repo: (source as { repo: Repo }).repo }) as Wrapped,
    author: () => ({ kind: 'user' }) as Wrapped,
  },
  PullRequest: {
    id: (_ctx, source) => {
      const wrapped = source as { repo: Repo; pull: Pull };
      return pullGlobalId(wrapped.repo, wrapped.pull);
    },
    number: (_ctx, source) => (source as { pull: Pull }).pull.number,
    title: (_ctx, source) => (source as { pull: Pull }).pull.title,
    body: (_ctx, source) => (source as { pull: Pull }).pull.body,
    state: (_ctx, source) => pullState((source as { pull: Pull }).pull),
    merged: (_ctx, source) => (source as { pull: Pull }).pull.merged,
    mergedAt: (_ctx, source) => (source as { pull: Pull }).pull.mergedAt,
    createdAt: (_ctx, source) => (source as { pull: Pull }).pull.createdAt,
    updatedAt: (_ctx, source) => (source as { pull: Pull }).pull.updatedAt,
    headRefName: (_ctx, source) => (source as { pull: Pull }).pull.headRef,
    baseRefName: (_ctx, source) => (source as { pull: Pull }).pull.baseRef,
    headRefOid: (ctx, source) => {
      const wrapped = source as { repo: Repo; pull: Pull };
      return ctx.forge.branchTip(wrapped.repo, wrapped.pull.headRef) ?? '';
    },
    baseRefOid: (ctx, source) => {
      const wrapped = source as { repo: Repo; pull: Pull };
      return ctx.forge.branchTip(wrapped.repo, wrapped.pull.baseRef) ?? '';
    },
    mergeable: (ctx, source) => {
      const wrapped = source as { repo: Repo; pull: Pull };
      if (wrapped.pull.state !== 'open') return 'UNKNOWN';
      return ctx.forge.pullConflicts(wrapped.repo, wrapped.pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (ctx, source, args) => {
      const wrapped = source as { repo: Repo; pull: Pull };
      const files = ctx.forge.pullDiff(wrapped.repo, wrapped.pull).map(
        (file) => ({
          kind: 'changedFile',
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          status: file.status,
        }) as Wrapped,
      );
      return makeConnection('PullRequestChangedFileConnection', 'PullRequestEdge', files, args.first, args.after);
    },
    repository: (_ctx, source) => ({ kind: 'repo', repo: (source as { repo: Repo }).repo }) as Wrapped,
    author: () => ({ kind: 'user' }) as Wrapped,
  },
  Ref: {
    id: (_ctx, source) => {
      const wrapped = source as { repo: Repo; name: string };
      return Buffer.from(`Ref:${wrapped.repo.id}:${wrapped.name}`, 'utf8').toString('base64');
    },
    name: (_ctx, source) => (source as { name: string }).name,
    prefix: () => 'refs/heads/',
  },
  IssueComment: {
    id: (_ctx, source) => commentGlobalId((source as { comment: { id: number } }).comment.id),
    body: (_ctx, source) => (source as { comment: { body: string } }).comment.body,
    createdAt: (_ctx, source) => (source as { comment: { createdAt: string } }).comment.createdAt,
    updatedAt: (_ctx, source) => (source as { comment: { createdAt: string } }).comment.createdAt,
    author: () => ({ kind: 'user' }) as Wrapped,
  },
  PullRequestChangedFile: {
    path: (_ctx, source) => (source as { path: string }).path,
    additions: (_ctx, source) => (source as { additions: number }).additions,
    deletions: (_ctx, source) => (source as { deletions: number }).deletions,
    changeType: (_ctx, source) => {
      const status = (source as { status: string }).status;
      return status === 'added' ? 'ADDED' : status === 'removed' ? 'DELETED' : 'MODIFIED';
    },
  },
};

// Connection plumbing: nodes are the window itself; edges wrap each node with
// its absolute cursor; pageInfo describes the window against the whole list.
for (const connType of ['IssueConnection', 'PullRequestConnection', 'PullRequestChangedFileConnection']) {
  RESOLVERS[connType] = {
    nodes: (_ctx, source) => (source as { items: Wrapped[] }).items,
    edges: (_ctx, source) => {
      const conn = source as { edgeTypeName: string; items: Wrapped[]; start: number };
      return conn.items.map((node, index) => ({
        kind: 'edge',
        typeName: conn.edgeTypeName,
        node,
        cursor: cursorFor(conn.start + index),
      }) as Wrapped);
    },
    pageInfo: (_ctx, source) => {
      const conn = source as { items: Wrapped[]; total: number; start: number };
      return {
        kind: 'pageInfo',
        hasNext: conn.start + conn.items.length < conn.total,
        hasPrevious: conn.start > 0,
        startCursor: conn.items.length > 0 ? cursorFor(conn.start) : null,
        endCursor: conn.items.length > 0 ? cursorFor(conn.start + conn.items.length - 1) : null,
      } as Wrapped;
    },
    totalCount: (_ctx, source) => (source as { total: number }).total,
  };
}
for (const edgeType of ['IssueEdge', 'PullRequestEdge', 'CommentEdge']) {
  RESOLVERS[edgeType] = {
    node: (_ctx, source) => (source as { node: Wrapped }).node,
    cursor: (_ctx, source) => (source as { cursor: string | null }).cursor,
  };
}
RESOLVERS.PageInfo = {
  hasNextPage: (_ctx, source) => (source as { hasNext: boolean }).hasNext,
  hasPreviousPage: (_ctx, source) => (source as { hasPrevious: boolean }).hasPrevious,
  startCursor: (_ctx, source) => (source as { startCursor: string | null }).startCursor,
  endCursor: (_ctx, source) => (source as { endCursor: string | null }).endCursor,
};

// Mutation payloads: each payload type exposes its one wrapped value under
// its one field (AddCommentPayload's value is the comment edge itself).
const PAYLOAD_FIELDS: Record<string, string> = {
  CreateIssuePayload: 'issue',
  CloseIssuePayload: 'issue',
  CreatePullRequestPayload: 'pullRequest',
  MergePullRequestPayload: 'pullRequest',
  AddCommentPayload: 'commentEdge',
};
for (const [payloadType, field] of Object.entries(PAYLOAD_FIELDS)) {
  RESOLVERS[payloadType] = {
    [field]: (_ctx, source) => (source as { value: Wrapped | null }).value,
  };
}

// Introspection: __Type answers name/kind/fields/enumValues out of the tables.
RESOLVERS.__Type = {
  name: (_ctx, source) => (source as { name: string }).name,
  kind: (_ctx, source) => (ENUM_VALUES[(source as { name: string }).name] !== undefined ? 'ENUM' : 'OBJECT'),
  fields: (_ctx, source) => {
    const fields = TYPE_FIELDS[(source as { name: string }).name];
    if (fields === undefined) return null;
    return fields.map((name) => ({ kind: 'fieldInfo', name }) as Wrapped);
  },
  enumValues: (_ctx, source) => {
    const values = ENUM_VALUES[(source as { name: string }).name];
    if (values === undefined) return null;
    return values.map((name) => ({ kind: 'enumInfo', name }) as Wrapped);
  },
};
RESOLVERS.__Field = {
  name: (_ctx, source) => (source as { name: string }).name,
};
RESOLVERS.__EnumValue = RESOLVERS.__Field;

// ---------------------------------------------------------------------------
// execution

function executeSelectionSet(
  ctx: Ctx,
  typeName: string,
  source: Wrapped | null,
  selections: SelectionNode[],
  out: Record<string, unknown>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        executeSelectionSet(ctx, typeName, source, selection.selectionSet, out);
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) executeSelectionSet(ctx, typeName, source, fragment, out);
      continue;
    }
    out[selection.alias ?? selection.name] = executeField(ctx, typeName, source, selection);
  }
}

function executeField(ctx: Ctx, typeName: string, source: Wrapped | null, field: FieldNode): unknown {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = valueOf(arg.value, ctx.variables);

  if (field.name === '__typename') return typeName;
  if (field.name === '__type' && typeName === 'Query') {
    const name = typeof args.name === 'string' ? args.name : '';
    if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
    if (field.selectionSet === null) return null;
    const out: Record<string, unknown> = {};
    executeSelectionSet(ctx, '__Type', { kind: 'typeInfo', name }, field.selectionSet, out);
    return out;
  }
  if (field.name === '__schema' && typeName === 'Query') return null;

  const resolver = RESOLVERS[typeName]?.[field.name];
  const known = resolver !== undefined || (TYPE_FIELDS[typeName]?.includes(field.name) ?? false);
  if (!known) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  return completeValue(ctx, resolver !== undefined ? resolver(ctx, source, args) : null, field.selectionSet);
}

function completeValue(ctx: Ctx, raw: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((entry) => completeValue(ctx, entry, selectionSet));
  if (isWrapped(raw)) {
    if (selectionSet === null) return null;
    const out: Record<string, unknown> = {};
    executeSelectionSet(ctx, typeNameOf(raw), raw, selectionSet, out);
    return out;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// entry point

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export function executeGraphQL(forge: Forge, request: GraphQLRequest): Record<string, unknown> {
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(request.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = request.operationName !== undefined && request.operationName !== ''
    ? document.operations.find((candidate) => candidate.name === request.operationName)
    : document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation found in the document' }] };
  }
  const ctx: Ctx = {
    forge,
    variables: request.variables ?? {},
    fragments: document.fragments,
    errors: [],
  };
  const data: Record<string, unknown> = {};
  executeSelectionSet(ctx, operation.operation === 'mutation' ? 'Mutation' : 'Query', null, operation.selectionSet, data);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
