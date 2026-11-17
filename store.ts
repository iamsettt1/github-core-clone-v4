// store.ts — the forge's shared in-memory state and domain operations.
//
// One global content-addressed object store serves every repository (a fetch
// only ever serves objects reachable from the requested repo's refs, so the
// sharing cannot leak across repos). Repositories keep their refs, issues and
// pull requests in Maps beside ordered arrays, so the hot REST paths are O(1).
// This module also owns the git object primitives (hashing, trees, commits)
// that both the smart-HTTP layer and the REST contents/merge paths build on,
// plus the per-object pack-entry cache and the generation stamps the
// fast-forward check walks.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- identity

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

export function nowIso(): string {
  return new Date().toISOString();
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- objects

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObject {
  type: ObjType;
  data: Buffer;
}

export interface CommitMeta {
  tree: string;
  parents: string[];
  /** 1 + max(parent generations); 0 for a root; -1 when a parent is unknown. */
  gen: number;
  author: string;
  committer: string;
  message: string;
}

/** Every git object the forge holds, by oid. */
export const objects = new Map<string, StoredObject>();
/** Parsed commit headers, by oid (commits only). */
export const commitMeta = new Map<string, CommitMeta>();
/** Pack-entry bytes (varint header + deflated payload) per oid: built once. */
export const packEntryCache = new Map<string, Buffer>();

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Parse a commit object's header block (tree, parents, identities, message). */
export function parseCommit(data: Buffer): CommitMeta {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const header = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, gen: -1, author, committer, message };
}

/** Parse a tag object: its target oid and target type. */
export function parseTag(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const header = data.subarray(0, headerEnd).toString('utf8');
  let object = '';
  let type = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return { object, type };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: byte order, directories compared as if named with a trailing slash. */
function treeEntryCompare(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Serialise tree entries (sorted the git way) into a tree object's bytes. */
export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeEntryCompare);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Store an object (idempotent) and return its oid. Commits also record their
 * parsed header and generation stamp here, so every writer — receive-pack,
 * the contents API, merges — shares the one bookkeeping path.
 */
export function storeObject(type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) {
    objects.set(oid, { type, data });
    if (type === 'commit') {
      const meta = parseCommit(data);
      let gen = 0;
      if (meta.parents.length > 0) {
        let max = -1;
        let known = true;
        for (const parent of meta.parents) {
          const parentMeta = commitMeta.get(parent);
          if (parentMeta === undefined || parentMeta.gen < 0) {
            known = false;
            break;
          }
          if (parentMeta.gen > max) max = parentMeta.gen;
        }
        gen = known ? max + 1 : -1;
      }
      meta.gen = gen;
      commitMeta.set(oid, meta);
    }
  }
  return oid;
}

/** Peel an oid through annotated tags to the object it ultimately names. */
export function peelToCommit(oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** The pack entry (type/size varint header + level-1 deflated payload) for one object, cached by oid. */
export function packEntryFor(oid: string): Buffer | null {
  const cached = packEntryCache.get(oid);
  if (cached !== undefined) return cached;
  const object = objects.get(oid);
  if (object === undefined) return null;
  const data = object.data;
  const size = data.length;
  const headerBytes: number[] = [];
  let first = (TYPE_CODE[object.type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  if (rest > 0) first |= 0x80;
  headerBytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    headerBytes.push(byte);
  }
  const entry = Buffer.concat([Buffer.from(headerBytes), deflateSync(data, { level: 1 })]);
  packEntryCache.set(oid, entry);
  return entry;
}

/** Assemble a version-2 pack from whole objects (no deltas), with its SHA-1 trailer. */
export function buildPack(oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const entry = packEntryFor(oid);
    if (entry !== null) parts.push(entry);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- repos

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  /** Serialized GET /issues/{n} response bytes, refreshed on every mutation. */
  cachedBody: Buffer;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileVersion {
  blob: string;
  size: number;
}

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  issueSeq: number;
  prs: PullRequest[];
  prByNumber: Map<number, PullRequest>;
  prSeq: number;
  refs: Map<string, string>;
  /** Lazy flat file maps per ref, validated against the ref's current tip. */
  branchFiles: Map<string, { tip: string; files: Map<string, FileVersion> }>;
  /** Bumped on any mutation; part of every fetch-cache key for this repo. */
  version: number;
}

export const repos = new Map<string, Repo>();
export const reposByDbId = new Map<number, Repo>();

let nextRepoDbId = 5000;
let nextIssueId = 1;
let nextCommentId = 1;
let globalSeq = 1;

export function createRepo(name: string, isPrivate: boolean, description: string | null): Repo | null {
  const fullName = `${VIEWER.login}/${name}`;
  if (repos.has(fullName)) return null;
  const stamp = nowIso();
  const repo: Repo = {
    dbId: nextRepoDbId,
    owner: VIEWER.login,
    name,
    fullName,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    createdAt: stamp,
    updatedAt: stamp,
    labels: new Map(),
    issues: [],
    issueByNumber: new Map(),
    issueSeq: 0,
    prs: [],
    prByNumber: new Map(),
    prSeq: 0,
    refs: new Map(),
    branchFiles: new Map(),
    version: 1,
  };
  nextRepoDbId += 1;
  repos.set(fullName, repo);
  reposByDbId.set(repo.dbId, repo);
  return repo;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repo.fullName);
  reposByDbId.delete(repo.dbId);
  clearFetchCacheFor(repo);
}

export function getRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return repos.get(`${owner}/${name}`) ?? null;
}

/** Viewer-owned repos in creation order. */
export function listRepos(): Repo[] {
  return [...repos.values()];
}

// ------------------------------------------------------- fetch cache hooks
// git.ts registers its cache-clearing callback here so a repo mutation from
// any surface (push, contents, merge, ref create) drops stale fetch packs.

let fetchCacheClearer: ((repo: Repo) => void) | null = null;

export function registerFetchCacheClearer(fn: (repo: Repo) => void): void {
  fetchCacheClearer = fn;
}

export function clearFetchCacheFor(repo: Repo): void {
  if (fetchCacheClearer !== null) fetchCacheClearer(repo);
}

/** Record a mutation of `repo`: bump its version and drop its cached fetches. */
export function touchRepo(repo: Repo): void {
  repo.version += 1;
  repo.updatedAt = nowIso();
  clearFetchCacheFor(repo);
}

// ---------------------------------------------------------------- files

/** Flatten a commit's tree into a path → blob map (recursive tree walk). */
export function filesOfCommit(commitOid: string): Map<string, FileVersion> {
  const files = new Map<string, FileVersion>();
  const meta = commitMeta.get(commitOid);
  if (meta === undefined) return files;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') {
        walk(entry.oid, `${prefix}${entry.name}/`);
      } else {
        const blob = objects.get(entry.oid);
        files.set(`${prefix}${entry.name}`, { blob: entry.oid, size: blob === undefined ? 0 : blob.data.length });
      }
    }
  };
  walk(meta.tree, '');
  return files;
}

/** The flat file map for a ref, served from the per-repo cache when the tip is unchanged. */
export function filesForRef(repo: Repo, ref: string): Map<string, FileVersion> {
  const tip = repo.refs.get(ref);
  if (tip === undefined) return new Map();
  const cached = repo.branchFiles.get(ref);
  if (cached !== undefined && cached.tip === tip) return cached.files;
  const files = filesOfCommit(tip);
  repo.branchFiles.set(ref, { tip, files });
  return files;
}

/** Build (and store) the tree hierarchy for a flat path → blob map; returns the root tree oid. */
export function buildTreeFromFiles(files: Map<string, FileVersion>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, version] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, version.blob);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, blob] of node.files) entries.push({ mode: '100644', name, oid: blob });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject('tree', buildTreeData(entries));
  };
  return build(root);
}

/** Commit bytes in git's exact layout, authored by the viewer identity. */
export function buildCommitData(tree: string, parents: readonly string[], message: string, timestampSec: number): Buffer {
  const who = `${VIEWER.name} <${VIEWER.email}> ${timestampSec} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${text}`, 'utf8');
}

/**
 * Create a commit on `branchRef` with the given flat file map and move the ref.
 * Handles the unborn case (no parent) and refreshes the branch file cache.
 */
export function commitOnBranch(repo: Repo, branchRef: string, files: Map<string, FileVersion>, message: string): string {
  const tree = buildTreeFromFiles(files);
  const tip = repo.refs.get(branchRef);
  const parents = tip === undefined ? [] : [tip];
  const commitOid = storeObject('commit', buildCommitData(tree, parents, message, nowSec()));
  repo.refs.set(branchRef, commitOid);
  repo.branchFiles.set(branchRef, { tip: commitOid, files });
  touchRepo(repo);
  return commitOid;
}

/** Resolve a branch name, ref name or oid to a commit oid, or null. */
export function resolveCommit(repo: Repo, value: string): string | null {
  if (value.startsWith('refs/')) {
    return repo.refs.get(value) ?? null;
  }
  const byBranch = repo.refs.get(`refs/heads/${value}`);
  if (byBranch !== undefined) return byBranch;
  if (isOid(value) && objects.has(value)) return value;
  return null;
}

// ---------------------------------------------------------------- issues

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/** Re-serialise an issue's cached read bytes after any change to it. */
export function refreshIssueCache(issue: Issue): void {
  issue.cachedBody = Buffer.from(JSON.stringify(issueJson(issue)), 'utf8');
}

export function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const stamp = nowIso();
  repo.issueSeq += 1;
  const issue: Issue = {
    id: nextIssueId,
    number: repo.issueSeq,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: globalSeq,
    createdAt: stamp,
    updatedAt: stamp,
    cachedBody: Buffer.alloc(0),
  };
  nextIssueId += 1;
  globalSeq += 1;
  repo.issues.push(issue);
  repo.issueByNumber.set(issue.number, issue);
  refreshIssueCache(issue);
  return issue;
}

export function commentJson(comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function addCommentRecord(repo: Repo, issue: Issue, body: string): IssueComment {
  const stamp = nowIso();
  const comment: IssueComment = { id: nextCommentId, body, createdAt: stamp, updatedAt: stamp };
  nextCommentId += 1;
  issue.comments.push(comment);
  issue.updatedAt = stamp;
  refreshIssueCache(issue);
  return comment;
}

// ------------------------------------------------------------ pull requests

export function createPullRecord(
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
  headSha: string,
  baseSha: string,
): PullRequest {
  const stamp = nowIso();
  repo.prSeq += 1;
  const pr: PullRequest = {
    id: nextIssueId,
    number: repo.prSeq,
    title,
    body,
    head,
    base,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headSha,
    baseSha,
    createdSeq: globalSeq,
    createdAt: stamp,
    updatedAt: stamp,
  };
  nextIssueId += 1;
  globalSeq += 1;
  repo.prs.push(pr);
  repo.prByNumber.set(pr.number, pr);
  return pr;
}

/** The live tip of a PR branch (its stored creation-time sha when the ref is gone). */
export function prHeadSha(repo: Repo, pr: PullRequest): string {
  return repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
}

export function prBaseSha(repo: Repo, pr: PullRequest): string {
  return repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
}

export function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.head, sha: prHeadSha(repo, pr), label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: prBaseSha(repo, pr), label: `${repo.owner}:${pr.base}` },
    user: { login: VIEWER.login },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

// ---------------------------------------------------------------- merging

/** Every commit reachable from `tip` (parent walk), as a set. */
export function ancestorSet(tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const meta = commitMeta.get(oid);
    if (meta !== undefined) for (const parent of meta.parents) stack.push(parent);
  }
  return seen;
}

/** The newest common ancestor of two tips: the shared commit with the highest generation. */
export function mergeBaseOf(a: string, b: string): string | null {
  const fromA = ancestorSet(a);
  let best: string | null = null;
  let bestGen = -2;
  for (const oid of ancestorSet(b)) {
    if (!fromA.has(oid)) continue;
    const gen = commitMeta.get(oid)?.gen ?? -1;
    if (gen > bestGen) {
      bestGen = gen;
      best = oid;
    }
  }
  return best;
}

export interface MergeOutcome {
  clean: boolean;
  files: Map<string, FileVersion>;
}

/** Three-way merge of flat file maps; a path both sides changed differently conflicts. */
export function threeWayMerge(
  baseFiles: Map<string, FileVersion>,
  headFiles: Map<string, FileVersion>,
  ancestorFiles: Map<string, FileVersion>,
): MergeOutcome {
  const files = new Map<string, FileVersion>();
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
  let clean = true;
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    const inAncestor = ancestorFiles.get(path);
    const baseChanged = inBase?.blob !== inAncestor?.blob;
    const headChanged = inHead?.blob !== inAncestor?.blob;
    if (baseChanged && headChanged && inBase?.blob !== inHead?.blob) {
      clean = false;
      continue;
    }
    const winner = headChanged ? inHead : inBase;
    if (winner !== undefined) files.set(path, winner);
  }
  return { clean, files };
}

/** The merge analysis for a PR against the branches' current tips. */
export function analyseMerge(repo: Repo, pr: PullRequest): { status: 'mergeable' | 'conflicting' | 'unknown'; files: Map<string, FileVersion> | null } {
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (headTip === undefined || baseTip === undefined) return { status: 'unknown', files: null };
  const base = mergeBaseOf(headTip, baseTip);
  if (base === null) return { status: 'unknown', files: null };
  const outcome = threeWayMerge(filesOfCommit(baseTip), filesOfCommit(headTip), filesOfCommit(base));
  return outcome.clean ? { status: 'mergeable', files: outcome.files } : { status: 'conflicting', files: null };
}

/**
 * Squash-merge a PR: one commit on the base branch holding the merged tree,
 * parented on the base tip, titled with the PR title. Returns the merge sha,
 * or null when the merge conflicts (the ref does not move).
 */
export function squashMerge(repo: Repo, pr: PullRequest): string | null {
  const analysis = analyseMerge(repo, pr);
  if (analysis.status !== 'mergeable' || analysis.files === null) return null;
  const baseRef = `refs/heads/${pr.base}`;
  const sha = commitOnBranch(repo, baseRef, analysis.files, pr.title);
  const stamp = nowIso();
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = stamp;
  pr.mergeCommitSha = sha;
  pr.updatedAt = stamp;
  return sha;
}

/** Line-multiset diff counts for one changed file; a change always counts at least one addition. */
export function lineDiffCounts(baseData: Buffer | null, headData: Buffer | null): { additions: number; deletions: number } {
  const linesOf = (data: Buffer | null): Map<string, number> => {
    const counts = new Map<string, number>();
    if (data === null) return counts;
    const text = data.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const baseLines = linesOf(baseData);
  const headLines = linesOf(headData);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of headLines) additions += Math.max(0, count - (baseLines.get(line) ?? 0));
  for (const [line, count] of baseLines) deletions += Math.max(0, count - (headLines.get(line) ?? 0));
  if (additions === 0 && deletions === 0) additions = 1;
  return { additions, deletions };
}

/** The changed-file list between the PR's base and head tips. */
export function pullFiles(repo: Repo, pr: PullRequest): Array<Record<string, unknown>> {
  const headTip = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
  const headFiles = filesOfCommit(headTip);
  const baseFiles = filesOfCommit(baseTip);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Array<Record<string, unknown>> = [];
  for (const path of [...paths].sort()) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    if (inBase?.blob === inHead?.blob) continue;
    const status = inBase === undefined ? 'added' : inHead === undefined ? 'removed' : 'modified';
    const baseData = inBase === undefined ? null : (objects.get(inBase.blob)?.data ?? null);
    const headData = inHead === undefined ? null : (objects.get(inHead.blob)?.data ?? null);
    const { additions, deletions } = lineDiffCounts(baseData, headData);
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

// ------------------------------------------------------------- global ids

/** Opaque, stable Relay-style global ids: base64url of a namespaced string. */
export function globalId(namespaced: string): string {
  return Buffer.from(namespaced, 'utf8').toString('base64url');
}

export function repoGlobalId(repo: Repo): string {
  return globalId(`repo:${repo.owner}:${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId(`issue:${repo.dbId}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pr: PullRequest): string {
  return globalId(`pr:${repo.dbId}:${pr.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return globalId(`comment:${repo.dbId}:${issue.number}:${comment.id}`);
}

/** Decode a global id back to its namespaced parts, or null when it is not one of ours. */
export function decodeGlobalId(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'repo' && parts[0] !== 'issue' && parts[0] !== 'pr' && parts[0] !== 'comment') return null;
    return parts;
  } catch {
    return null;
  }
}
