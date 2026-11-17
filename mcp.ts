// mcp.ts — the Model Context Protocol endpoint (JSON-RPC 2.0 over Streamable
// HTTP, plain JSON answers). The tool list is one frozen constant, so two
// tools/list calls are byte-identical. Tools execute against the same store
// as REST and GraphQL, so an object created over MCP is the same object over
// REST, with the same ids.

import {
  VIEWER,
  createIssueRecord,
  createPullRecord,
  createRepo,
  getRepo,
  issueJson,
  pullJson,
  squashMerge,
  type Repo,
} from './store.ts';

export const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' } as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function stringProp(description: string): { type: string; description: string } {
  return { type: 'string', description };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function repoJsonForMcp(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

interface ToolOutcome {
  payload: unknown;
  isError: boolean;
}

function toolError(message: string): ToolOutcome {
  return { payload: { message }, isError: true };
}

function runTool(name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      const existing = getRepo(VIEWER.login, repoName);
      if (existing !== null) return { payload: repoJsonForMcp(existing), isError: false };
      const repo = createRepo(
        repoName,
        typeof args.private === 'boolean' ? args.private : false,
        typeof args.description === 'string' ? args.description : null,
      );
      if (repo === null) return toolError(`repository ${repoName} already exists`);
      return { payload: repoJsonForMcp(repo), isError: false };
    }
    case 'get_repo': {
      const repo = getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return toolError('repository not found');
      return { payload: repoJsonForMcp(repo), isError: false };
    }
    case 'create_issue': {
      const repo = getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return toolError('repository not found');
      const issue = createIssueRecord(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return { payload: issueJson(issue), isError: false };
    }
    case 'list_issues': {
      const repo = getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { payload: list.map((issue) => issueJson(issue)), isError: false };
    }
    case 'create_pull_request': {
      const repo = getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return toolError('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return toolError('head or base branch not found');
      const existing = repo.prs.find((pr) => pr.head === head && pr.state === 'open');
      const pr =
        existing ??
        createPullRecord(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
      return { payload: pullJson(repo, pr), isError: false };
    }
    case 'merge_pull_request': {
      const repo = getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return toolError('repository not found');
      const pr = repo.prByNumber.get(Number(args.pull_number ?? -1));
      if (pr === undefined) return toolError('pull request not found');
      if (!pr.merged) {
        const sha = squashMerge(repo, pr);
        if (sha === null) return toolError('pull request is not mergeable');
      }
      return { payload: pullJson(repo, pr), isError: false };
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export interface McpReply {
  status: number;
  body: Buffer | null;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), 'utf8') };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), 'utf8') };
}

/** Handle one parsed JSON-RPC request object. Notifications (no id) get an empty 200. */
export function handleMcpMessage(message: Record<string, unknown>): McpReply {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined || id === null;
  if (method.startsWith('notifications/')) {
    return { status: 200, body: null };
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...MCP_SERVER_INFO } },
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOL_BY_NAME.get(toolName);
      if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${toolName}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(id, -32602, `missing required argument: ${required}`);
        }
      }
      const outcome = runTool(toolName, args);
      const text = JSON.stringify(outcome.payload);
      return rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.payload,
        isError: outcome.isError,
      });
    }
    default:
      if (isNotification) return { status: 200, body: null };
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** The -32700 reply for a body that is not JSON; the id is salvaged from the raw text when possible. */
export function mcpParseError(rawText: string): McpReply {
  let id: unknown = null;
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(rawText);
  if (match !== null) {
    try {
      id = JSON.parse(match[1] as string);
    } catch {
      id = null;
    }
  }
  return rpcError(id, -32700, 'parse error', 400);
}
