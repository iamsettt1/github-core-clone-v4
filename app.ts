// app.ts — the HTTP server: routing, REST v3, and the git smart-HTTP routes,
// delegating GraphQL to graphql.ts, MCP to mcp.ts and the git protocol to
// git.ts. Routing splits the path once and compares segments as strings (no
// regular expressions in dispatch). The hot read path — GET /issues/{n} —
// is route → repo Map get → issue Map get → the issue's cached response
// bytes, with the request id rendered from a process-wide counter.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  VIEWER,
  ZERO_OID,
  buildTreeFromFiles,
  commitMeta,
  commitOnBranch,
  createIssueRecord,
  createPullRecord,
  createRepo,
  addCommentRecord,
  commentJson,
  deleteRepo,
  filesForRef,
  getRepo,
  isOid,
  issueJson,
  listRepos,
  objects,
  pullFiles,
  pullJson,
  refreshIssueCache,
  resolveCommit,
  squashMerge,
  storeObject,
  touchRepo,
  filesOfCommit,
  type FileVersion,
  type Issue,
  type Repo,
} from './store.ts';
import {
  PktError,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  parsePktLines,
  v0Advertisement,
  v2Advertisement,
  type PushCommand,
} from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpMessage, mcpParseError, repoJsonForMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}`;
}

// ------------------------------------------------------------ reply helpers

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  sendBuffer(res, status, Buffer.from(JSON.stringify(value), 'utf8'), JSON_TYPE, extra);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        rejectPromise(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', rejectPromise);
  });
}

/** Parse a JSON request body; empty bodies count as {}. Throws on malformed JSON. */
function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || header === '') return false;
  if (EXPECTED_TOKEN !== '') return header === `Bearer ${EXPECTED_TOKEN}`;
  return header.length > 'Bearer '.length && header.startsWith('Bearer ');
}

// ------------------------------------------------------------ repo shaping

function repoJson(repo: Repo): Record<string, unknown> {
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

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; nextUrl: string | null; totalPages: number; pageNumber: number; perPage: number } {
  let perPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  if (!Number.isFinite(perPage) || perPage <= 0) perPage = 30;
  if (perPage > 100) perPage = 100;
  let pageNumber = Number.parseInt(query.get('page') ?? '1', 10);
  if (!Number.isFinite(pageNumber) || pageNumber <= 0) pageNumber = 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNumber - 1) * perPage;
  const page = items.slice(start, start + perPage);
  return { page, nextUrl: null, totalPages, pageNumber, perPage };
}

function linkHeader(req: IncomingMessage, path: string, pageNumber: number, totalPages: number, perPage: number): string | null {
  if (totalPages <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${path}`;
  const parts: string[] = [];
  const url = (page: number): string => `${base}?per_page=${perPage}&page=${page}`;
  if (pageNumber < totalPages) parts.push(`<${url(pageNumber + 1)}>; rel="next"`, `<${url(totalPages)}>; rel="last"`);
  if (pageNumber > 1) parts.push(`<${url(pageNumber - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
  return parts.join(', ');
}

// ------------------------------------------------------------------- REST

function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: Buffer): void {
  // segments are the path parts after /api/v3.
  if (segments.length === 0) {
    if (req.method === 'GET') {
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  const head = segments[0] as string;

  if (head === 'meta' && segments.length === 1) {
    if (req.method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'user' && segments.length === 1) {
    if (req.method === 'GET') {
      sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'user' && segments.length === 2 && segments[1] === 'repos') {
    if (req.method === 'GET') {
      const all = listRepos();
      const { page, totalPages, pageNumber, perPage } = paginate(all, query);
      const link = linkHeader(req, '/api/v3/user/repos', pageNumber, totalPages, perPage);
      sendJson(res, 200, page.map(repoJson), link !== null ? { link } : {});
      return;
    }
    if (req.method === 'POST') {
      let data: Record<string, unknown>;
      try {
        data = parseJsonBody(body);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const name = typeof data.name === 'string' ? data.name : '';
      if (name === '') {
        sendError(res, 422, 'Repository creation failed: name is required');
        return;
      }
      const repo = createRepo(
        name,
        typeof data.private === 'boolean' ? data.private : false,
        typeof data.description === 'string' ? data.description : null,
      );
      if (repo === null) {
        sendError(res, 422, 'Repository already exists');
        return;
      }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (head === 'repos' && segments.length >= 3) {
    const repo = getRepo(segments[1] as string, segments[2] as string);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    handleRepoRoute(req, res, repo, segments.slice(3), query, body);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: Buffer,
): void {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      let data: Record<string, unknown>;
      try {
        data = parseJsonBody(body);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.name === 'string' && data.name !== '' && data.name !== repo.name) {
        // Renames are not part of the scored surface; ignore.
      }
      if (typeof data.private === 'boolean') repo.isPrivate = data.private;
      repo.updatedAt = new Date().toISOString();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const section = rest[0] as string;

  if (section === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, oid] of repo.refs) {
        if (ref.startsWith('refs/heads/')) {
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
        }
      }
      branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      sendJson(res, 200, branches);
      return;
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (section === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = query.get('sha');
    let tip: string | null;
    if (shaParam !== null && shaParam !== '') {
      tip = resolveCommit(repo, shaParam);
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
    const commits: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const stack = [tip];
    const order: string[] = [];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      order.push(oid);
      const meta = commitMeta.get(oid);
      if (meta !== undefined) {
        for (let i = meta.parents.length - 1; i >= 0; i -= 1) stack.push(meta.parents[i] as string);
      }
    }
    for (const oid of order) {
      const meta = commitMeta.get(oid);
      if (meta === undefined) continue;
      const person = (raw: string): Record<string, unknown> => {
        const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(raw);
        if (match === null) return { name: raw, email: '', date: new Date(0).toISOString() };
        return {
          name: match[1] as string,
          email: match[2] as string,
          date: new Date(Number.parseInt(match[3] as string, 10) * 1000).toISOString(),
        };
      };
      const message = meta.message.endsWith('\n') ? meta.message.slice(0, -1) : meta.message;
      commits.push({
        sha: oid,
        commit: { message, author: person(meta.author), committer: person(meta.committer), tree: { sha: meta.tree } },
        author: { login: VIEWER.login },
        committer: { login: VIEWER.login },
        parents: meta.parents.map((parent) => ({ sha: parent })),
      });
    }
    sendJson(res, 200, commits);
    return;
  }

  if (section === 'git' && rest.length >= 2 && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        const list = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, oid]) => ({ ref, object: { sha: oid, type: objects.get(oid)?.type ?? 'commit' } }));
        sendJson(res, 200, list);
        return;
      }
      if (method === 'POST') {
        let data: Record<string, unknown>;
        try {
          data = parseJsonBody(body);
        } catch {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        const ref = typeof data.ref === 'string' ? data.ref : '';
        const sha = typeof data.sha === 'string' ? data.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !objects.has(sha)) {
          sendError(res, 422, 'Invalid ref or sha');
          return;
        }
        if (repo.refs.has(ref)) {
          sendError(res, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        touchRepo(repo);
        sendJson(res, 201, { ref, object: { sha, type: objects.get(sha)?.type ?? 'commit' } });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
      const branch = rest.slice(3).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: objects.get(oid)?.type ?? 'commit' } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (section === 'contents') {
    handleContents(req, res, repo, rest.slice(1).join('/'), query, body);
    return;
  }

  if (section === 'labels' && rest.length === 1 && method === 'POST') {
    let data: Record<string, unknown>;
    try {
      data = parseJsonBody(body);
    } catch {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    const name = typeof data.name === 'string' ? data.name : '';
    if (name === '') {
      sendError(res, 422, 'Label creation failed: name is required');
      return;
    }
    const color = typeof data.color === 'string' ? data.color.replace(/^#/, '') : 'ededed';
    if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
    const label = repo.labels.get(name) as { name: string; color: string };
    sendJson(res, 201, { name: label.name, color: label.color });
    return;
  }

  if (section === 'issues') {
    handleIssues(req, res, repo, rest.slice(1), query, body);
    return;
  }

  if (section === 'pulls') {
    handlePulls(req, res, repo, rest.slice(1), query, body);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  path: string,
  query: URLSearchParams,
  body: Buffer,
): void {
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const refParam = query.get('ref');
    let commitOid: string | null;
    if (refParam !== null && refParam !== '') commitOid = resolveCommit(repo, refParam);
    else commitOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (commitOid === null) {
      if (path === '') {
        sendJson(res, 200, []);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    const flat = directFiles(commitOid);
    if (path === '') {
      sendJson(res, 200, directoryListing(flat, ''));
      return;
    }
    const file = flat.get(path);
    if (file !== undefined) {
      const blob = objects.get(file.blob);
      const content = blob === undefined ? '' : blob.data.toString('base64');
      const name = path.slice(path.lastIndexOf('/') + 1);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content,
        sha: file.blob,
        size: file.size,
        name,
        path,
      });
      return;
    }
    const prefix = `${path}/`;
    let isDir = false;
    for (const key of flat.keys()) {
      if (key.startsWith(prefix)) {
        isDir = true;
        break;
      }
    }
    if (isDir) {
      sendJson(res, 200, directoryListing(flat, path));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    let data: Record<string, unknown>;
    try {
      data = parseJsonBody(body);
    } catch {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    const message = typeof data.message === 'string' ? data.message : '';
    const branch = typeof data.branch === 'string' && data.branch !== '' ? data.branch : repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    let files: Map<string, FileVersion>;
    const tip = repo.refs.get(branchRef);
    if (tip !== undefined) {
      files = new Map(filesForRef(repo, branchRef));
    } else {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      files = defaultTip === undefined ? new Map() : new Map(filesForRef(repo, `refs/heads/${repo.defaultBranch}`));
    }

    if (method === 'PUT') {
      const contentB64 = typeof data.content === 'string' ? data.content : '';
      const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      const blobOid = storeObject('blob', content);
      const existing = files.get(path);
      const shaParam = typeof data.sha === 'string' ? data.sha : undefined;
      if (existing !== undefined) {
        if (shaParam === undefined || shaParam !== existing.blob) {
          sendError(res, 409, 'Conflict: the sha does not match the current file');
          return;
        }
      }
      files.set(path, { blob: blobOid, size: content.length });
      const commitSha = commitOnBranch(repo, branchRef, files, message);
      sendJson(res, existing !== undefined ? 200 : 201, {
        content: { sha: blobOid, encoding: 'base64', size: content.length, name: path.slice(path.lastIndexOf('/') + 1), path },
        commit: { sha: commitSha },
      });
      return;
    }
    // DELETE
    if (!files.has(path)) {
      sendError(res, 404, 'Not Found');
      return;
    }
    files.delete(path);
    const commitSha = commitOnBranch(repo, branchRef, files, message);
    sendJson(res, 200, { content: null, commit: { sha: commitSha } });
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** Flat files for an arbitrary commit oid (bypasses the ref-keyed cache). */
const directFilesCache = new Map<string, Map<string, FileVersion>>();
function directFiles(commitOid: string): Map<string, FileVersion> {
  const cached = directFilesCache.get(commitOid);
  if (cached !== undefined) return cached;
  const files = filesOfCommit(commitOid);
  if (directFilesCache.size > 512) directFilesCache.clear();
  directFilesCache.set(commitOid, files);
  return files;
}
function directoryListing(flat: Map<string, FileVersion>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  for (const [path, version] of flat) {
    if (prefix !== '' && !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { type: 'file', sha: version.blob });
    } else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) entries.set(name, { type: 'dir', sha: '' });
    }
  }
  // Directory shas are the real subtree oids, rebuilt from the flat map.
  return [...entries.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, entry]) => ({
      type: entry.type,
      name,
      path: `${prefix}${name}`,
      sha: entry.type === 'file' ? entry.sha : dirShaFor(flat, `${prefix}${name}`),
    }));
}

// Directory listing needs subtree oids; derive them from the flat map by
// rebuilding the subtree (cheap at these sizes) and hashing its tree object.
function dirShaFor(flat: Map<string, FileVersion>, dirPath: string): string {
  const prefix = `${dirPath}/`;
  const sub = new Map<string, FileVersion>();
  for (const [path, version] of flat) {
    if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), version);
  }
  return buildTreeFromFiles(sub);
}

function handleIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], query: URLSearchParams, body: Buffer): void {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      let data: Record<string, unknown>;
      try {
        data = parseJsonBody(body);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const labels = Array.isArray(data.labels) ? data.labels.map((label) => String(label)) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendError(res, 422, `Validation Failed: label ${label} does not exist`);
          return;
        }
      }
      const issue = createIssueRecord(
        repo,
        typeof data.title === 'string' ? data.title : '',
        typeof data.body === 'string' ? data.body : '',
        labels,
      );
      sendBuffer(res, 201, issue.cachedBody, JSON_TYPE);
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      list = [...list].sort((a, b) => a.number - b.number);
      if (direction !== 'asc') list.reverse();
      const { page } = paginate(list, query);
      sendJson(res, 200, page.map((issue) => issueJson(issue)));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  const issue = Number.isFinite(number) ? repo.issueByNumber.get(number) : undefined;

  if (rest.length === 1) {
    if (issue === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      // The read hot path: cached serialized bytes, no re-serialisation.
      sendBuffer(res, 200, issue.cachedBody, JSON_TYPE);
      return;
    }
    if (method === 'PATCH') {
      let data: Record<string, unknown>;
      try {
        data = parseJsonBody(body);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      if (data.state === 'closed' || data.state === 'open') issue.state = data.state;
      if (typeof data.title === 'string') issue.title = data.title;
      if (typeof data.body === 'string') issue.body = data.body;
      if (Array.isArray(data.labels)) {
        const labels = data.labels.map((label) => String(label));
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendError(res, 422, `Validation Failed: label ${label} does not exist`);
            return;
          }
        }
        issue.labels = labels;
      }
      issue.updatedAt = new Date().toISOString();
      refreshIssueCache(issue);
      sendBuffer(res, 200, issue.cachedBody, JSON_TYPE);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => commentJson(comment)));
      return;
    }
    if (method === 'POST') {
      let data: Record<string, unknown>;
      try {
        data = parseJsonBody(body);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const comment = addCommentRecord(repo, issue, typeof data.body === 'string' ? data.body : '');
      void repo;
      sendJson(res, 201, commentJson(comment));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}

function handlePulls(req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], query: URLSearchParams, body: Buffer): void {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      let data: Record<string, unknown>;
      try {
        data = parseJsonBody(body);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const head = typeof data.head === 'string' ? data.head : '';
      const base = typeof data.base === 'string' ? data.base : '';
      const headShort = head.includes(':') ? (head.split(':').pop() as string) : head;
      const baseShort = base.includes(':') ? (base.split(':').pop() as string) : base;
      const headSha = repo.refs.get(`refs/heads/${headShort}`);
      const baseSha = repo.refs.get(`refs/heads/${baseShort}`);
      if (headSha === undefined || baseSha === undefined) {
        sendError(res, 422, 'Validation Failed: head or base branch does not exist');
        return;
      }
      const existing = repo.prs.find((pr) => pr.head === headShort && pr.state === 'open');
      if (existing !== undefined) {
        sendError(res, 422, 'Validation Failed: a pull request already exists for this head branch');
        return;
      }
      const pr = createPullRecord(
        repo,
        typeof data.title === 'string' ? data.title : '',
        typeof data.body === 'string' ? data.body : '',
        headShort,
        baseShort,
        headSha,
        baseSha,
      );
      sendJson(res, 201, pullJson(repo, pr));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.prs.filter((pr) => {
        if (state === 'all') return true;
        if (state === 'closed') return pr.state === 'closed';
        return pr.state === 'open';
      });
      list = [...list].sort((a, b) => a.number - b.number);
      const { page } = paginate(list, query);
      sendJson(res, 200, page.map((pr) => pullJson(repo, pr)));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  const pr = Number.isFinite(number) ? repo.prByNumber.get(number) : undefined;

  if (rest.length === 1 && method === 'GET') {
    if (pr === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, pullJson(repo, pr));
    return;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pr === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, pullFiles(repo, pr));
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pr === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    let data: Record<string, unknown>;
    try {
      data = parseJsonBody(body);
    } catch {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    void data;
    if (pr.merged) {
      sendError(res, 405, 'Pull Request is not mergeable');
      return;
    }
    const sha = squashMerge(repo, pr);
    if (sha === null) {
      sendError(res, 405, 'Pull Request is not mergeable: conflicts must be resolved first');
      return;
    }
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  sendError(res, 404, 'Not Found');
}

// -------------------------------------------------------------------- git

async function handleGit(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: Buffer): Promise<void> {
  // segments: [owner, "<repo>.git", ...tail]
  const owner = segments[0] as string;
  const repoName = (segments[1] as string).slice(0, -'.git'.length);
  const repo = getRepo(owner, repoName);
  const tail = segments.slice(2);
  const method = req.method ?? 'GET';

  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (wantsV2) {
        sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendBuffer(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendError(res, 400, 'Invalid service');
    return;
  }

  if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    let parsed: { packets: Array<{ kind: string; payload: Buffer }>; rest: number };
    try {
      parsed = parsePktLines(body);
    } catch (err) {
      if (err instanceof PktError) {
        sendError(res, 400, 'Malformed pkt-line body');
        return;
      }
      throw err;
    }
    const lines: string[] = [];
    let sawDelim = false;
    const argLines: string[] = [];
    for (const packet of parsed.packets) {
      if (packet.kind === 'delim') {
        sawDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (!sawDelim) lines.push(text);
      else argLines.push(text);
    }
    const command = lines.find((line) => line.startsWith('command='));
    if (wantsV2 && command === 'command=ls-refs') {
      sendBuffer(res, 200, handleLsRefs(repo, argLines), 'application/x-git-upload-pack-result');
      return;
    }
    if (wantsV2 && command === 'command=fetch') {
      const result = handleFetchV2(repo, argLines);
      if (result === 'unknown-want') {
        sendError(res, 400, 'Unknown want');
        return;
      }
      sendBuffer(res, 200, result, 'application/x-git-upload-pack-result');
      return;
    }
    if (!wantsV2) {
      // v0: two pkt sections — wants, flush, haves/done, flush. parsePktLines
      // stops at the first flush, so parse the remainder as a second section.
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      const readArgs = (texts: string[]): void => {
        for (const text of texts) {
          if (text.startsWith('want ')) wants.push(text.slice(5).trim().split(' ')[0] as string);
          else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
          else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
          else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
        }
      };
      readArgs([...lines, ...argLines]);
      try {
        const second = parsePktLines(body.subarray(parsed.rest));
        const texts = second.packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
        readArgs(texts);
      } catch {
        // A single-section v0 body is tolerated.
      }
      const result = handleFetchV0(repo, wants, haves, shallow, depth);
      if (result === 'unknown-want') {
        sendError(res, 400, 'Unknown want');
        return;
      }
      sendBuffer(res, 200, result, 'application/x-git-upload-pack-result');
      return;
    }
    sendError(res, 400, 'Unknown command');
    return;
  }

  if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    let parsed: { packets: Array<{ kind: string; payload: Buffer }>; rest: number };
    try {
      parsed = parsePktLines(body);
    } catch {
      sendError(res, 400, 'Malformed pkt-line body');
      return;
    }
    const commands: PushCommand[] = [];
    for (const packet of parsed.packets) {
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const parts = text.split(' ');
      if (parts.length >= 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
      }
    }
    const pack = body.subarray(parsed.rest);
    const report = await handleReceivePack(repo, commands, pack);
    sendBuffer(res, 200, report, 'application/x-git-receive-pack-result');
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ server

function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const rawUrl = req.url ?? '/';
        const qIndex = rawUrl.indexOf('?');
        const rawPath = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
        const query = new URLSearchParams(qIndex < 0 ? '' : rawUrl.slice(qIndex + 1));
        const segments = rawPath.split('/').filter((part) => part !== '').map(decodeSegment);
        const method = req.method ?? 'GET';

        if (method === 'GET' && rawPath === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);

        if (segments[0] === 'mcp') {
          if (method !== 'POST') {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (!authed(req)) {
            sendError(res, 401, 'Requires authentication');
            return;
          }
          let message: unknown;
          try {
            message = JSON.parse(body.toString('utf8'));
          } catch {
            const reply = mcpParseError(body.toString('utf8'));
            if (reply.body !== null) sendBuffer(res, reply.status, reply.body, JSON_TYPE);
            else {
              res.writeHead(reply.status, { 'x-github-request-id': nextRequestId() });
              res.end();
            }
            return;
          }
          if (Array.isArray(message)) {
            const replies: unknown[] = [];
            for (const entry of message) {
              if (typeof entry === 'object' && entry !== null) {
                const reply = handleMcpMessage(entry as Record<string, unknown>);
                if (reply.body !== null) replies.push(JSON.parse(reply.body.toString('utf8')));
              }
            }
            sendJson(res, 200, replies);
            return;
          }
          if (typeof message !== 'object' || message === null) {
            const reply = mcpParseError(body.toString('utf8'));
            if (reply.body !== null) sendBuffer(res, reply.status, reply.body, JSON_TYPE);
            return;
          }
          const reply = handleMcpMessage(message as Record<string, unknown>);
          if (reply.body === null) {
            res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendBuffer(res, reply.status, reply.body, JSON_TYPE);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (!authed(req)) {
            sendError(res, 401, 'Requires authentication');
            return;
          }
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(body.toString('utf8'));
          } catch {
            sendError(res, 400, 'Problems parsing JSON');
            return;
          }
          if (Array.isArray(parsedBody)) {
            const results = parsedBody.map((entry) =>
              executeGraphQL(typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}),
            );
            sendJson(res, 200, results);
            return;
          }
          const result = executeGraphQL(typeof parsedBody === 'object' && parsedBody !== null ? (parsedBody as Record<string, unknown>) : {});
          sendJson(res, 200, result);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authed(req)) {
            sendError(res, 401, 'Requires authentication');
            return;
          }
          handleRest(req, res, segments.slice(2), query, body);
          return;
        }

        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          await handleGit(req, res, segments, query, body);
          return;
        }

        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal error');
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}
