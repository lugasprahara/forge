// GraphQL v4 (POST /api/graphql): a small parser for the documents gh and
// github-mcp-server send (operations, variables, aliases, inline fragments, input
// objects, enum lists, batching) and a schema-driven executor over the forge store.
// Unknown fields are GraphQL errors in a 200 body, never HTTP errors; an unknown
// repository is data.repository = null with no errors.

import { VIEWER, type Forge, type Issue, type Pull, type Repo } from './forge.ts';
import { isRecord } from './webutil.ts';

// ---------------------------------------------------------------------------
// global ids: opaque, stable, and never the plain database id

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

interface DecodedId {
  type: string;
  parts: string[];
}

function decodeGlobalId(id: string): DecodedId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { type: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// tokenizer + parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'spread' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        const value = source.slice(index + 3, end < 0 ? source.length : end);
        tokens.push({ kind: 'string', value });
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const esc = source[index + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16));
            index += 4;
          } else value += esc;
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      let end = index;
      while (end < source.length && isNameChar(source[end]!)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = index;
      while (end < source.length && /[0-9.eE+-]/.test(source[end]!)) end += 1;
      const text = source.slice(index, end);
      if (/[.eE]/.test(text)) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: parseInt(text, 10) });
      index = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

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

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
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
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && maybeName.kind === 'name') name = this.expectName();
        if (this.skipPunct('(')) this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({
          operation: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName();
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition "${token.value}" in GraphQL document`);
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    // Positioned just after '('; consume through the matching ')'.
    let depth = 1;
    while (this.pos < this.tokens.length && depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.skipPunct('(')) {
        let depth = 1;
        while (this.pos < this.tokens.length && depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
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
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.skipPunct('(')) {
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
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
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
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
// schema: introspection field lists and enum values

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
// execution

interface GqlError {
  message: string;
}

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: GqlError[];
}

type Wrapped =
  | { __type: 'User' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueComment'; repo: Repo; comment: { id: number; body: string; createdAt: string } }
  | { __type: 'Ref'; repo: Repo; name: string }
  | { __type: 'Connection'; connType: string; items: Wrapped[]; totalCount: number; startOffset: number }
  | { __type: 'ChangedFile'; path: string; additions: number; deletions: number; status: string }
  | { __type: 'Payload'; payloadType: string; value: Wrapped | null }
  | { __type: 'CommentEdge'; node: Wrapped }
  | { __type: 'TypeInfo'; name: string };

function typeNameOf(value: Wrapped): string {
  switch (value.__type) {
    case 'Connection':
      return value.connType;
    case 'Payload':
      return value.payloadType;
    case 'ChangedFile':
      return 'PullRequestChangedFile';
    case 'TypeInfo':
      return '__Type';
    default:
      return value.__type;
  }
}

function findRepoByDbId(forge: Forge, dbId: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function resolveNode(forge: Forge, id: string): Wrapped | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = findRepoByDbId(forge, Number(decoded.parts[0]));
    return repo === null ? null : { __type: 'Repository', repo };
  }
  if (decoded.type === 'Issue') {
    const repo = findRepoByDbId(forge, Number(decoded.parts[0]));
    const issue = repo?.issues.get(Number(decoded.parts[1]));
    return repo && issue ? { __type: 'Issue', repo, issue } : null;
  }
  if (decoded.type === 'PullRequest') {
    const repo = findRepoByDbId(forge, Number(decoded.parts[0]));
    const pull = repo?.pulls.get(Number(decoded.parts[1]));
    return repo && pull ? { __type: 'PullRequest', repo, pull } : null;
  }
  if (decoded.type === 'User') return { __type: 'User' };
  return null;
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function offsetOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionSpec {
  items: Wrapped[];
  first: number | null;
  after: unknown;
  connType: string;
}

function makeConnection(spec: ConnectionSpec): Wrapped {
  const start = spec.after === null || spec.after === undefined ? 0 : offsetOfCursor(spec.after) + 1;
  const first = spec.first === null || spec.first === undefined ? spec.items.length : Math.max(0, spec.first);
  const slice = spec.items.slice(start, start + first);
  return {
    __type: 'Connection',
    connType: spec.connType,
    items: slice,
    totalCount: spec.items.length,
    startOffset: start,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// Field resolvers. A resolver returns a Wrapped, a scalar, an array, or null.
type Resolver = (ctx: Ctx, source: Wrapped | null, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __type: 'User' }) as Wrapped,
    repository: (ctx, _source, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.forge.getRepo(owner, name);
      return repo === null ? null : ({ __type: 'Repository', repo }) as Wrapped;
    },
    node: (ctx, _source, args) => (typeof args.id === 'string' ? resolveNode(ctx.forge, args.id) : null),
    nodes: (ctx, _source, args) => {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      return ids.map((id) => (typeof id === 'string' ? resolveNode(ctx.forge, id) : null));
    },
    user: (_ctx, _source, args) => (args.login === VIEWER.login ? ({ __type: 'User' }) as Wrapped : null),
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoByDbId(ctx.forge, Number(decoded.parts[0])) : null;
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve the repository for createIssue' });
        return { __type: 'Payload', payloadType: 'CreateIssuePayload', value: null } as Wrapped;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.forge.createIssue(repo, title, body, []);
      return { __type: 'Payload', payloadType: 'CreateIssuePayload', value: { __type: 'Issue', repo, issue } } as Wrapped;
    },
    closeIssue: (ctx, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const node = typeof input.issueId === 'string' ? resolveNode(ctx.forge, input.issueId) : null;
      if (node === null || node.__type !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve the issue for closeIssue' });
        return { __type: 'Payload', payloadType: 'CloseIssuePayload', value: null } as Wrapped;
      }
      node.issue.state = 'closed';
      node.issue.updatedAt = ctx.forge.nowIso();
      return { __type: 'Payload', payloadType: 'CloseIssuePayload', value: node } as Wrapped;
    },
    createPullRequest: (ctx, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoByDbId(ctx.forge, Number(decoded.parts[0])) : null;
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (repo === null || ctx.forge.branchTip(repo, head) === null || ctx.forge.branchTip(repo, base) === null) {
        ctx.errors.push({ message: 'Could not create the pull request: a branch does not exist' });
        return { __type: 'Payload', payloadType: 'CreatePullRequestPayload', value: null } as Wrapped;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const pull = ctx.forge.createPull(repo, title, body, head, base);
      return { __type: 'Payload', payloadType: 'CreatePullRequestPayload', value: { __type: 'PullRequest', repo, pull } } as Wrapped;
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const node = typeof input.pullRequestId === 'string' ? resolveNode(ctx.forge, input.pullRequestId) : null;
      if (node === null || node.__type !== 'PullRequest') {
        ctx.errors.push({ message: 'Could not resolve the pull request for mergePullRequest' });
        return { __type: 'Payload', payloadType: 'MergePullRequestPayload', value: null } as Wrapped;
      }
      const { repo, pull } = node;
      if (!pull.merged) {
        const sha = ctx.forge.mergePull(repo, pull);
        if (sha === null) {
          ctx.errors.push({ message: 'The pull request is not mergeable' });
          return { __type: 'Payload', payloadType: 'MergePullRequestPayload', value: null } as Wrapped;
        }
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = ctx.forge.nowIso();
        pull.mergeCommitSha = sha;
        pull.updatedAt = pull.mergedAt;
      }
      return { __type: 'Payload', payloadType: 'MergePullRequestPayload', value: node } as Wrapped;
    },
    addComment: (ctx, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const node = typeof input.subjectId === 'string' ? resolveNode(ctx.forge, input.subjectId) : null;
      const body = typeof input.body === 'string' ? input.body : '';
      if (node === null || (node.__type !== 'Issue' && node.__type !== 'PullRequest')) {
        ctx.errors.push({ message: 'Could not resolve the subject for addComment' });
        return { __type: 'Payload', payloadType: 'AddCommentPayload', value: null } as Wrapped;
      }
      const comment = { id: ctx.forge.nextEntityId(), body, createdAt: ctx.forge.nowIso() };
      if (node.__type === 'Issue') node.issue.comments.push(comment);
      else node.pull.comments.push(comment);
      const wrapped: Wrapped = { __type: 'IssueComment', repo: node.repo, comment };
      return { __type: 'Payload', payloadType: 'AddCommentPayload', value: { __type: 'CommentEdge', node: wrapped } } as Wrapped;
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
    owner: () => ({ __type: 'User' }) as Wrapped,
    description: (_ctx, source) => (source as { repo: Repo }).repo.description,
    isPrivate: (_ctx, source) => (source as { repo: Repo }).repo.isPrivate,
    createdAt: (_ctx, source) => (source as { repo: Repo }).repo.createdAt,
    updatedAt: (_ctx, source) => (source as { repo: Repo }).repo.createdAt,
    defaultBranchRef: (ctx, source) => {
      const repo = (source as { repo: Repo }).repo;
      if (ctx.forge.branchTip(repo, repo.defaultBranch) === null) return null;
      return { __type: 'Ref', repo, name: repo.defaultBranch } as Wrapped;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => false,
    hasWikiEnabled: () => false,
    issue: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : ({ __type: 'Issue', repo, issue }) as Wrapped;
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
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      items.sort((a, b) => {
        const key = field === 'COMMENTS' ? a.comments.length - b.comments.length : a.seq - b.seq;
        return direction === 'ASC' ? key : -key;
      });
      const wrapped = items.map((issue) => ({ __type: 'Issue', repo, issue }) as Wrapped);
      return makeConnection({
        items: wrapped,
        first: typeof args.first === 'number' ? args.first : null,
        after: args.after,
        connType: 'IssueConnection',
      });
    },
    pullRequest: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : ({ __type: 'PullRequest', repo, pull }) as Wrapped;
    },
    pullRequests: (_ctx, source, args) => {
      const repo = (source as { repo: Repo }).repo;
      let items = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null && states.length > 0) items = items.filter((pull) => states.includes(pullState(pull)));
      items.sort((a, b) => b.seq - a.seq);
      const wrapped = items.map((pull) => ({ __type: 'PullRequest', repo, pull }) as Wrapped);
      return makeConnection({
        items: wrapped,
        first: typeof args.first === 'number' ? args.first : null,
        after: args.after,
        connType: 'PullRequestConnection',
      });
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
    repository: (_ctx, source) => ({ __type: 'Repository', repo: (source as { repo: Repo }).repo }) as Wrapped,
    author: () => ({ __type: 'User' }) as Wrapped,
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
        (file) => ({ __type: 'ChangedFile', path: file.path, additions: file.additions, deletions: file.deletions, status: file.status }) as Wrapped,
      );
      return makeConnection({
        items: files,
        first: typeof args.first === 'number' ? args.first : null,
        after: args.after,
        connType: 'PullRequestChangedFileConnection',
      });
    },
    repository: (_ctx, source) => ({ __type: 'Repository', repo: (source as { repo: Repo }).repo }) as Wrapped,
    author: () => ({ __type: 'User' }) as Wrapped,
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
    author: () => ({ __type: 'User' }) as Wrapped,
  },
  ChangedFile: {
    path: (_ctx, source) => (source as { path: string }).path,
    additions: (_ctx, source) => (source as { additions: number }).additions,
    deletions: (_ctx, source) => (source as { deletions: number }).deletions,
    changeType: (_ctx, source) => {
      const status = (source as { status: string }).status;
      return status === 'added' ? 'ADDED' : status === 'removed' ? 'DELETED' : 'MODIFIED';
    },
  },
};

function payloadField(payloadType: string, field: string): Resolver {
  return (_ctx, source) => {
    const wrapped = source as { value: Wrapped | null };
    if (wrapped.value === null) return null;
    if (payloadType === 'AddCommentPayload') {
      // value is a CommentEdge wrapper; commentEdge resolves to it.
      return field === 'commentEdge' ? wrapped.value : null;
    }
    return wrapped.value;
  };
}

for (const [payloadType, field] of [
  ['CreateIssuePayload', 'issue'],
  ['CloseIssuePayload', 'issue'],
  ['CreatePullRequestPayload', 'pullRequest'],
  ['MergePullRequestPayload', 'pullRequest'],
  ['AddCommentPayload', 'commentEdge'],
] as const) {
  RESOLVERS[payloadType] = { [field]: payloadField(payloadType, field) };
}

function connectionField(field: string): Resolver {
  return (_ctx, source) => {
    const conn = source as { items: Wrapped[]; totalCount: number; startOffset: number; connType: string };
    if (field === 'nodes') return conn.items;
    if (field === 'totalCount') return conn.totalCount;
    if (field === 'edges') {
      return conn.items.map((node, index) => ({
        __type: 'Payload',
        payloadType: 'EdgeShim',
        value: node,
        // cursor/edge plumbing is handled in executeObject via a special case below
        edgeIndex: conn.startOffset + index,
      })) as unknown;
    }
    if (field === 'pageInfo') {
      const hasNext = conn.startOffset + conn.items.length < conn.totalCount;
      return {
        __type: 'Payload',
        payloadType: 'PageInfoShim',
        value: null,
        pageInfo: {
          hasNextPage: hasNext,
          hasPreviousPage: conn.startOffset > 0,
          startCursor: conn.items.length > 0 ? cursorFor(conn.startOffset) : null,
          endCursor: conn.items.length > 0 ? cursorFor(conn.startOffset + conn.items.length - 1) : null,
        },
      } as unknown;
    }
    return null;
  };
}

RESOLVERS.PullRequestChangedFile = RESOLVERS.ChangedFile;
RESOLVERS.IssueConnection = {
  nodes: connectionField('nodes'),
  edges: connectionField('edges'),
  pageInfo: connectionField('pageInfo'),
  totalCount: connectionField('totalCount'),
};
RESOLVERS.PullRequestConnection = RESOLVERS.IssueConnection;
RESOLVERS.PullRequestChangedFileConnection = RESOLVERS.IssueConnection;
RESOLVERS.CommentEdge = {
  node: (_ctx, source) => (source as unknown as { node: Wrapped }).node,
  cursor: () => null,
};
RESOLVERS.EdgeShim = {
  node: (_ctx, source) => (source as unknown as { value: Wrapped }).value,
  cursor: (_ctx, source) => cursorFor((source as unknown as { edgeIndex: number }).edgeIndex),
};
RESOLVERS.PageInfoShim = {
  hasNextPage: (_ctx, source) => (source as unknown as { pageInfo: { hasNextPage: boolean } }).pageInfo.hasNextPage,
  hasPreviousPage: (_ctx, source) => (source as unknown as { pageInfo: { hasPreviousPage: boolean } }).pageInfo.hasPreviousPage,
  startCursor: (_ctx, source) => (source as unknown as { pageInfo: { startCursor: string | null } }).pageInfo.startCursor,
  endCursor: (_ctx, source) => (source as unknown as { pageInfo: { endCursor: string | null } }).pageInfo.endCursor,
};

// ---------------------------------------------------------------------------
// selection execution

function isWrapped(value: unknown): value is Wrapped {
  return isRecord(value) && typeof value.__type === 'string';
}

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
      if (fragment) executeSelectionSet(ctx, typeName, source, fragment, out);
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(ctx, typeName, source, selection);
  }
}

function executeField(ctx: Ctx, typeName: string, source: Wrapped | null, field: FieldNode): unknown {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = valueOf(arg.value, ctx.variables);

  if (field.name === '__typename') return typeName;
  if (field.name === '__type' && typeName === 'Query') {
    const name = typeof args.name === 'string' ? args.name : '';
    const known = TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined;
    if (!known) return null;
    const wrapped: Wrapped = { __type: 'TypeInfo', name };
    if (field.selectionSet === null) return null;
    const out: Record<string, unknown> = {};
    executeSelectionSet(ctx, '__Type', wrapped, field.selectionSet, out);
    return out;
  }
  if (field.name === '__schema' && typeName === 'Query') return null;

  const typeResolvers = RESOLVERS[typeName];
  const resolver = typeResolvers?.[field.name];
  const knownField = resolver !== undefined || (TYPE_FIELDS[typeName]?.includes(field.name) ?? false);
  if (!knownField) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  const raw = resolver !== undefined ? resolver(ctx, source, args) : null;
  return completeValue(ctx, raw, field.selectionSet);
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
  // PageInfo / edge shims are plain records whose keys are the fields.
  if (isRecord(raw)) {
    if (selectionSet === null) return raw;
    const out: Record<string, unknown> = {};
    for (const selection of selectionSet) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      if (selection.name === 'node' && 'value' in raw) {
        out[key] = completeValue(ctx, (raw as { value: unknown }).value, selection.selectionSet);
      } else if (selection.name === 'cursor' && 'edgeIndex' in raw) {
        out[key] = cursorFor((raw as { edgeIndex: number }).edgeIndex);
      } else if ('pageInfo' in raw) {
        const pageInfo = (raw as { pageInfo: Record<string, unknown> }).pageInfo;
        out[key] = pageInfo[selection.name] ?? null;
      } else {
        out[key] = (raw as Record<string, unknown>)[selection.name] ?? null;
      }
    }
    return out;
  }
  return raw;
}

// __Type introspection resolvers.
RESOLVERS.__Type = {
  name: (_ctx, source) => (source as { name: string }).name,
  kind: (_ctx, source) => {
    const name = (source as { name: string }).name;
    return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
  },
  fields: (_ctx, source) => {
    const name = (source as { name: string }).name;
    const fields = TYPE_FIELDS[name];
    if (fields === undefined) return null;
    return fields.map((fieldName) => ({ __type: 'Payload', payloadType: '__Field', value: null, fieldName }) as unknown);
  },
  enumValues: (_ctx, source) => {
    const name = (source as { name: string }).name;
    const values = ENUM_VALUES[name];
    if (values === undefined) return null;
    return values.map((valueName) => ({ __type: 'Payload', payloadType: '__EnumValue', value: null, fieldName: valueName }) as unknown);
  },
};
RESOLVERS.__Field = {
  name: (_ctx, source) => (source as unknown as { fieldName: string }).fieldName,
};
RESOLVERS.__EnumValue = RESOLVERS.__Field;

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
  let operation: OperationNode | undefined;
  if (request.operationName !== undefined && request.operationName !== '') {
    operation = document.operations.find((candidate) => candidate.name === request.operationName);
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else {
    operation = document.operations[0];
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation found in the document' }] };
  }
  const ctx: Ctx = {
    forge,
    variables: request.variables ?? {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  executeSelectionSet(ctx, rootType, null, operation.selectionSet, data);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
