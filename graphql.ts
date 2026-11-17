// graphql.ts — a small hand-written GraphQL v4 executor: tokeniser,
// recursive-descent parser (selection sets, arguments, variables, aliases,
// inline fragments, named fragments) and a resolver table over the shared
// store. No string matching on documents: every query the suite sends is
// parsed and executed field by field, unknown fields are reported in an
// `errors` array while the valid fields still resolve, and a missing
// repository resolves to null without errors.

import {
  VIEWER,
  analyseMerge,
  commentGlobalId,
  decodeGlobalId,
  getRepo,
  globalId,
  issueGlobalId,
  pullFiles,
  pullGlobalId,
  pullJson,
  repoGlobalId,
  reposByDbId,
  squashMerge,
  createIssueRecord,
  createPullRecord,
  addCommentRecord,
  refreshIssueCache,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ------------------------------------------------------------------ parsing

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, Value>;
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$@!|='.includes(ch)) {
      tokens.push({ kind: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private tokens: Array<{ kind: string; value: string }>;
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): { kind: string; value: string } | undefined {
    return this.tokens[this.pos];
  }

  private next(): { kind: string; value: string } {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(kind: string): { kind: string; value: string } {
    const token = this.next();
    if (token.kind !== kind) throw new GqlSyntaxError(`expected ${kind}, got ${token.value}`);
    return token;
  }

  private skip(kind: string): boolean {
    if (this.peek()?.kind === kind) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selection: SelectionNode[] }>();
    while (this.peek() !== undefined) {
      const token = this.peek() as { kind: string; value: string };
      if (token.kind === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        const variableDefaults = new Map<string, Value>();
        if (this.skip('(')) {
          while (!this.skip(')')) {
            this.expect('$');
            const varName = this.expect('name').value;
            this.expect(':');
            this.parseType();
            if (this.skip('=')) variableDefaults.set(varName, this.parseValue());
            while (this.peek()?.kind === '@') this.parseDirective();
          }
        }
        while (this.peek()?.kind === '@') this.parseDirective();
        operations.push({ type: token.value as 'query' | 'mutation', name, variableDefaults, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        const onToken = this.expect('name');
        if (onToken.value !== 'on') throw new GqlSyntaxError('fragment needs a type condition');
        const typeCondition = this.expect('name').value;
        while (this.peek()?.kind === '@') this.parseDirective();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new GqlSyntaxError(`unexpected token ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.expect('name');
    }
    this.skip('!');
  }

  private parseDirective(): void {
    this.expect('@');
    this.expect('name');
    if (this.skip('(')) {
      while (!this.skip(')')) {
        this.expect('name');
        this.expect(':');
        this.parseValue();
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.skip('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek()?.kind === 'spread') {
      this.next();
      if (this.peek()?.kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        while (this.peek()?.kind === '@') this.parseDirective();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expect('name').value;
      while (this.peek()?.kind === '@') this.parseDirective();
      return { kind: 'spread', name };
    }
    let name = this.expect('name').value;
    let alias: string | null = null;
    if (this.skip(':')) {
      alias = name;
      name = this.expect('name').value;
    }
    const args = new Map<string, Value>();
    if (this.skip('(')) {
      while (!this.skip(')')) {
        const argName = this.expect('name').value;
        this.expect(':');
        args.set(argName, this.parseValue());
      }
    }
    while (this.peek()?.kind === '@') this.parseDirective();
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === '$') return { kind: 'variable', name: this.expect('name').value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === '[') {
      const values: Value[] = [];
      while (!this.skip(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.skip('}')) {
        const fieldName = this.expect('name').value;
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GqlSyntaxError(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- execution

interface Ctx {
  variables: Record<string, unknown>;
  defaults: Map<string, Value>;
  fragments: Document['fragments'];
  errors: Array<{ message: string }>;
}

function resolveValue(ctx: Ctx, value: Value): unknown {
  switch (value.kind) {
    case 'variable': {
      if (Object.prototype.hasOwnProperty.call(ctx.variables, value.name)) return ctx.variables[value.name];
      const fallback = ctx.defaults.get(value.name);
      return fallback === undefined ? null : resolveValue(ctx, fallback);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(ctx, entry));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(ctx, field.value);
      return out;
    }
  }
}

function argsOf(ctx: Ctx, field: FieldNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of field.args) out[name] = resolveValue(ctx, value);
  return out;
}

type Wrapper =
  | { type: 'User' }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Ref'; name: string }
  | { type: 'Issue'; repo: Repo; issue: Issue }
  | { type: 'IssueConnection'; repo: Repo; nodes: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { type: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { type: 'PullRequestConnection'; repo: Repo; nodes: PullRequest[] }
  | { type: 'PullRequestFileConnection'; paths: string[] }
  | { type: 'ChangedFile'; path: string }
  | { type: 'Comment'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { type: 'TypeInfo'; name: string }
  | { type: 'FieldInfo'; name: string }
  | { type: 'EnumInfo'; name: string }
  | { type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { type: 'CreatePullRequestPayload'; repo: Repo; pr: PullRequest }
  | { type: 'MergePullRequestPayload'; repo: Repo; pr: PullRequest }
  | { type: 'AddCommentPayload'; node: Extract<Wrapper, { type: 'Comment' }> }
  | { type: 'CommentEdge'; node: Extract<Wrapper, { type: 'Comment' }> };

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'labels', 'repository', 'url', 'updatedAt', 'closed'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'author', 'createdAt', 'url', 'mergeCommit', 'additions', 'deletions', 'changedFiles'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'primaryLanguage'];
const USER_FIELDS = ['login', 'id', 'name', 'email', 'url', 'createdAt'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

function typeFields(name: string): string[] | null {
  switch (name) {
    case 'Issue':
      return ISSUE_FIELDS;
    case 'PullRequest':
      return PULL_REQUEST_FIELDS;
    case 'Repository':
      return REPOSITORY_FIELDS;
    case 'User':
      return USER_FIELDS;
    default:
      return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findRepoByGlobalId(id: string): Repo | null {
  const parts = decodeGlobalId(id);
  if (parts === null) return null;
  if (parts[0] === 'repo') {
    const owner = parts[1] ?? '';
    const name = parts.slice(2).join(':');
    return getRepo(owner, name);
  }
  if (parts[0] === 'issue' || parts[0] === 'pr' || parts[0] === 'comment') {
    return reposByDbId.get(Number.parseInt(parts[1] ?? '', 10)) ?? null;
  }
  return null;
}

function resolveNode(id: string): Wrapper | null {
  const parts = decodeGlobalId(id);
  if (parts === null) return null;
  if (parts[0] === 'repo') {
    const repo = findRepoByGlobalId(id);
    return repo === null ? null : { type: 'Repository', repo };
  }
  if (parts[0] === 'issue') {
    const repo = findRepoByGlobalId(id);
    const issue = repo?.issueByNumber.get(Number.parseInt(parts[2] ?? '', 10));
    return repo !== null && repo !== undefined && issue !== undefined ? { type: 'Issue', repo, issue } : null;
  }
  if (parts[0] === 'pr') {
    const repo = findRepoByGlobalId(id);
    const pr = repo?.prByNumber.get(Number.parseInt(parts[2] ?? '', 10));
    return repo !== null && repo !== undefined && pr !== undefined ? { type: 'PullRequest', repo, pr } : null;
  }
  return null;
}

/** Resolve one field on a wrapped value; `undefined` means the field does not exist on the type. */
function resolveField(ctx: Ctx, source: Wrapper | null, rootType: 'Query' | 'Mutation', field: FieldNode): unknown {
  const args = argsOf(ctx, field);
  if (source === null) {
    if (rootType === 'Query') {
      switch (field.name) {
        case 'viewer':
          return { type: 'User' } as Wrapper;
        case 'repository': {
          const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo === null ? null : ({ type: 'Repository', repo } as Wrapper);
        }
        case 'node': {
          return resolveNode(String(args.id ?? ''));
        }
        case '__type': {
          const name = String(args.name ?? '');
          if (typeFields(name) !== null || name === 'SearchType' || name === 'Query' || name === 'Mutation') {
            return { type: 'TypeInfo', name } as Wrapper;
          }
          return null;
        }
        case '__typename':
          return 'Query';
        default:
          return undefined;
      }
    }
    // Mutations.
    switch (field.name) {
      case 'createIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === null) {
          ctx.errors.push({ message: 'repository not found for createIssue' });
          return null;
        }
        const issue = createIssueRecord(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        return { type: 'CreateIssuePayload', repo, issue } as Wrapper;
      }
      case 'closeIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(String(input.issueId ?? ''));
        const parts = decodeGlobalId(String(input.issueId ?? ''));
        const issue = repo !== null && parts !== null ? repo.issueByNumber.get(Number.parseInt(parts[2] ?? '', 10)) : undefined;
        if (repo === null || issue === undefined) {
          ctx.errors.push({ message: 'issue not found for closeIssue' });
          return null;
        }
        issue.state = 'closed';
        issue.updatedAt = new Date().toISOString();
        refreshIssueCache(issue);
        return { type: 'CloseIssuePayload', repo, issue } as Wrapper;
      }
      case 'createPullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === null) {
          ctx.errors.push({ message: 'repository not found for createPullRequest' });
          return null;
        }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) {
          ctx.errors.push({ message: 'head or base branch not found for createPullRequest' });
          return null;
        }
        const existing = repo.prs.find((pr) => pr.head === head && pr.state === 'open');
        const pr =
          existing ??
          createPullRecord(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
        return { type: 'CreatePullRequestPayload', repo, pr } as Wrapper;
      }
      case 'mergePullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(String(input.pullRequestId ?? ''));
        const parts = decodeGlobalId(String(input.pullRequestId ?? ''));
        const pr = repo !== null && parts !== null ? repo.prByNumber.get(Number.parseInt(parts[2] ?? '', 10)) : undefined;
        if (repo === null || pr === undefined) {
          ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
          return null;
        }
        if (!pr.merged) {
          const sha = squashMerge(repo, pr);
          if (sha === null) {
            ctx.errors.push({ message: 'pull request is not mergeable' });
            return null;
          }
        }
        return { type: 'MergePullRequestPayload', repo, pr } as Wrapper;
      }
      case 'addComment': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const subjectId = String(input.subjectId ?? '');
        const repo = findRepoByGlobalId(subjectId);
        const parts = decodeGlobalId(subjectId);
        const issue = repo !== null && parts !== null && parts[0] === 'issue' ? repo.issueByNumber.get(Number.parseInt(parts[2] ?? '', 10)) : undefined;
        if (repo === null || issue === undefined) {
          ctx.errors.push({ message: 'subject not found for addComment' });
          return null;
        }
        const comment = addCommentRecord(repo, issue, String(input.body ?? ''));
        const node: Wrapper = { type: 'Comment', repo, issue, commentId: comment.id, body: comment.body };
        return { type: 'AddCommentPayload', node: node as Extract<Wrapper, { type: 'Comment' }> } as Wrapper;
      }
      default:
        return undefined;
    }
  }

  switch (source.type) {
    case 'User':
      switch (field.name) {
        case 'login':
          return VIEWER.login;
        case 'id':
          return globalId(`user:${VIEWER.login}`);
        case 'name':
          return VIEWER.name;
        case 'email':
          return VIEWER.email;
        case '__typename':
          return 'User';
        default:
          return undefined;
      }
    case 'Repository': {
      const repo = source.repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return { type: 'User' } as Wrapper;
        case 'defaultBranchRef':
          return { type: 'Ref', name: repo.defaultBranch } as Wrapper;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'issue': {
          const issue = repo.issueByNumber.get(Number(args.number ?? -1));
          return issue === undefined ? null : ({ type: 'Issue', repo, issue } as Wrapper);
        }
        case 'issues': {
          let list = [...repo.issues];
          const states = args.states as unknown[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          const direction = orderBy !== null && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
          list.sort((a, b) => a.number - b.number);
          if (direction !== 'ASC') list.reverse();
          let startIndex = 0;
          const after = args.after;
          if (typeof after === 'string' && after !== '') {
            try {
              const cursorNumber = Number.parseInt(Buffer.from(after, 'base64url').toString('utf8'), 10);
              const at = list.findIndex((issue) => issue.number === cursorNumber);
              if (at >= 0) startIndex = at + 1;
            } catch {
              startIndex = 0;
            }
          }
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
          const page = list.slice(startIndex, startIndex + first);
          const hasNextPage = startIndex + page.length < list.length;
          const last = page[page.length - 1];
          const endCursor = last === undefined ? null : Buffer.from(String(last.number), 'utf8').toString('base64url');
          return { type: 'IssueConnection', repo, nodes: page, hasNextPage, endCursor } as Wrapper;
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : repo.prs.length;
          const nodes = [...repo.prs].sort((a, b) => a.number - b.number).slice(0, first);
          return { type: 'PullRequestConnection', repo, nodes } as Wrapper;
        }
        case 'pullRequest': {
          const pr = repo.prByNumber.get(Number(args.number ?? -1));
          return pr === undefined ? null : ({ type: 'PullRequest', repo, pr } as Wrapper);
        }
        case '__typename':
          return 'Repository';
        default:
          return undefined;
      }
    }
    case 'Ref':
      switch (field.name) {
        case 'name':
          return source.name;
        case '__typename':
          return 'Ref';
        default:
          return undefined;
      }
    case 'Issue': {
      const { repo, issue } = source;
      switch (field.name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        case '__typename':
          return 'Issue';
        default:
          return undefined;
      }
    }
    case 'IssueConnection':
      switch (field.name) {
        case 'nodes':
          return source.nodes.map((issue) => ({ type: 'Issue', repo: source.repo, issue }) as Wrapper);
        case 'pageInfo':
          return { type: 'PageInfo', hasNextPage: source.hasNextPage, endCursor: source.endCursor } as Wrapper;
        case 'totalCount':
          return source.nodes.length;
        case '__typename':
          return 'IssueConnection';
        default:
          return undefined;
      }
    case 'PageInfo':
      switch (field.name) {
        case 'hasNextPage':
          return source.hasNextPage;
        case 'endCursor':
          return source.endCursor;
        case 'hasPreviousPage':
          return false;
        case 'startCursor':
          return source.endCursor;
        default:
          return undefined;
      }
    case 'PullRequest': {
      const { repo, pr } = source;
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo, pr);
        case 'number':
          return pr.number;
        case 'title':
          return pr.title;
        case 'body':
          return pr.body;
        case 'state':
          return pullState(pr);
        case 'merged':
          return pr.merged;
        case 'headRefName':
          return pr.head;
        case 'baseRefName':
          return pr.base;
        case 'mergeable': {
          const status = analyseMerge(repo, pr).status;
          return status === 'mergeable' ? 'MERGEABLE' : status === 'conflicting' ? 'CONFLICTING' : 'UNKNOWN';
        }
        case 'files': {
          const files = pullFiles(repo, pr);
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
          const paths = files.slice(0, first).map((file) => String(file.filename));
          return { type: 'PullRequestFileConnection', paths } as Wrapper;
        }
        case '__typename':
          return 'PullRequest';
        default:
          return undefined;
      }
    }
    case 'PullRequestConnection':
      switch (field.name) {
        case 'nodes':
          return source.nodes.map((pr) => ({ type: 'PullRequest', repo: source.repo, pr }) as Wrapper);
        case 'totalCount':
          return source.nodes.length;
        case '__typename':
          return 'PullRequestConnection';
        default:
          return undefined;
      }
    case 'PullRequestFileConnection':
      switch (field.name) {
        case 'nodes':
          return source.paths.map((path) => ({ type: 'ChangedFile', path }) as Wrapper);
        case 'totalCount':
          return source.paths.length;
        default:
          return undefined;
      }
    case 'ChangedFile':
      switch (field.name) {
        case 'path':
          return source.path;
        default:
          return undefined;
      }
    case 'Comment':
      switch (field.name) {
        case 'id':
          return commentGlobalId(source.repo, source.issue, { id: source.commentId, body: source.body, createdAt: '', updatedAt: '' });
        case 'body':
          return source.body;
        case '__typename':
          return 'IssueComment';
        default:
          return undefined;
      }
    case 'TypeInfo':
      switch (field.name) {
        case 'name':
          return source.name;
        case 'kind':
          return source.name === 'SearchType' ? 'ENUM' : 'OBJECT';
        case 'fields': {
          const names = typeFields(source.name) ?? [];
          return names.map((name) => ({ type: 'FieldInfo', name }) as Wrapper);
        }
        case 'enumValues': {
          if (source.name !== 'SearchType') return [];
          return SEARCH_TYPE_VALUES.map((name) => ({ type: 'EnumInfo', name }) as Wrapper);
        }
        default:
          return undefined;
      }
    case 'FieldInfo':
    case 'EnumInfo':
      switch (field.name) {
        case 'name':
          return source.name;
        default:
          return undefined;
      }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      switch (field.name) {
        case 'issue':
          return { type: 'Issue', repo: source.repo, issue: source.issue } as Wrapper;
        default:
          return undefined;
      }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      switch (field.name) {
        case 'pullRequest':
          return { type: 'PullRequest', repo: source.repo, pr: source.pr } as Wrapper;
        default:
          return undefined;
      }
    case 'AddCommentPayload':
      switch (field.name) {
        case 'commentEdge':
          return { type: 'CommentEdge', node: source.node } as Wrapper;
        default:
          return undefined;
      }
    case 'CommentEdge':
      switch (field.name) {
        case 'node':
          return source.node as Wrapper;
        default:
          return undefined;
      }
  }
}

function isWrapper(value: unknown): value is Wrapper {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function executeSelection(ctx: Ctx, source: Wrapper | null, rootType: 'Query' | 'Mutation', selection: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (nodes: SelectionNode[], current: Wrapper | null, currentRoot: 'Query' | 'Mutation' | null): void => {
    for (const node of nodes) {
      if (node.kind === 'inline') {
        if (node.typeCondition === null || current === null || current.type === node.typeCondition || node.typeCondition === 'Node') {
          walk(node.selection, current, currentRoot);
        }
        continue;
      }
      if (node.kind === 'spread') {
        const fragment = ctx.fragments.get(node.name);
        if (fragment !== undefined) {
          if (fragment.typeCondition === null || current === null || current.type === fragment.typeCondition || fragment.typeCondition === 'Node') {
            walk(fragment.selection, current, currentRoot);
          }
        }
        continue;
      }
      const key = node.alias ?? node.name;
      const value = resolveField(ctx, current, currentRoot ?? 'Query', node);
      if (value === undefined) {
        const ownerName = current === null ? (currentRoot ?? 'Query') : current.type;
        ctx.errors.push({ message: `Field '${node.name}' is undefined on ${ownerName} (noSuchField: ${node.name})` });
        out[key] = null;
        continue;
      }
      out[key] = completeValue(ctx, value, node);
    }
  };
  walk(selection, source, rootType);
  return out;
}

function completeValue(ctx: Ctx, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, field));
  if (isWrapper(value)) {
    if (field.selection === null) return null;
    return executeSelection(ctx, value, 'Query', field.selection);
  }
  return value;
}

/** Execute one GraphQL operation body ({query, variables, operationName?}) into a result envelope. */
export function executeGraphQL(body: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'no operation in document' }] };
  }
  let operation = document.operations[0] as Operation;
  if (typeof body.operationName === 'string' && body.operationName !== '') {
    const named = document.operations.find((op) => op.name === body.operationName);
    if (named !== undefined) operation = named;
  } else if (document.operations.length > 1) {
    // Anonymous selection among several: use the first.
    operation = document.operations[0] as Operation;
  }
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  const ctx: Ctx = { variables, defaults: operation.variableDefaults, fragments: document.fragments, errors: [] };
  const data = executeSelection(ctx, null, operation.type === 'mutation' ? 'Mutation' : 'Query', operation.selection);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// Re-exported for app.ts convenience (pull JSON is not needed here, but the
// import keeps the module graph explicit about the shared store surface).
export { pullJson };
