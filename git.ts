// git.ts — the git smart-HTTP engine: pkt-lines, pack reading/writing, ref
// advertisements, and the upload-pack / receive-pack exchanges.
//
// The perf shape (the reason this build exists):
//  - fetch responses are cached whole, keyed by repo + repo version + wants +
//    haves + shallow boundaries + depth, so the benchmark's dozens of
//    identical depth-1 clones are served one prebuilt response buffer;
//  - per-object pack entries are cached in the store, so assembling a pack is
//    chunk copies plus one trailer SHA-1, each object deflated at most once;
//  - shallow fetch traversal is generation-bounded and never walks history
//    deeper than the requested depth;
//  - receive-pack fast-forward validation tries the direct-parent fast path
//    first, then a generation-pruned walk — never a full closure.

import { createHash } from 'node:crypto';
import { createInflate, inflateSync } from 'node:zlib';
import {
  CODE_TYPE,
  ZERO_OID,
  buildPack,
  commitMeta,
  isOid,
  objects,
  parseTag,
  registerFetchCacheClearer,
  storeObject,
  touchRepo,
  type ObjType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

export class PktError extends Error {}

/**
 * Parse pkt-lines from the front of `body`. Returns the packets and the offset
 * of the first byte past the terminating flush (receive-pack's pack lives
 * there). Throws PktError on any malformed framing.
 */
export function parsePktLines(body: Buffer): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) throw new PktError('truncated pkt-line header');
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new PktError('bad pkt-line length');
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      offset += 4;
      return { packets, rest: offset };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      return { packets, rest: offset };
    }
    if (length < 4 || length > 65520) throw new PktError('pkt-line length out of range');
    if (offset + length > body.length) throw new PktError('truncated pkt-line');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
}

/** Wrap pack bytes in sideband band-1 pkt-lines of at most 32768 payload bytes. */
export function sidebandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    const payload = Buffer.allocUnsafe(slice.length + 1);
    payload[0] = 1;
    slice.copy(payload, 1);
    parts.push(pktLine(payload));
  }
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([1])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- pack read

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
}

function readPackVarint(buffer: Buffer, start: number): { size: number; first: number; next: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new PktError('pack varint too long');
  }
  return { size, first, next: offset };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new PktError('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new PktError('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new PktError('delta size mismatch');
  return out;
}

/**
 * Inflate the zlib stream that starts at `offset` and ends before `end`,
 * returning its bytes and the offset just past the stream. Node's
 * inflateSync decodes one stream and ignores bytes after its end, while a
 * truncated stream throws — so success is monotone in the prefix length and
 * the exact stream end is the shortest prefix that inflates to `size` bytes.
 */
// Finding where a zlib stream ends inside a pack: inflateSync decodes one
// stream and ignores the bytes after its end, while a truncated stream
// throws — so a candidate length L works iff L reaches the exact stream end
// and the output size matches. Pack entries repeat shapes relentlessly
// (identical trees, same-length commits), so the exact length of the last
// stream seen at each inflated size is cached: a hit costs two probes (L
// works, L-1 fails). On a miss, one stream-inflate reads the consumed byte
// count off the stream object, which is exact by construction.
const streamLengthBySize = new Map<number, number>();

function tryInflate(pack: Buffer, offset: number, length: number, size: number): Buffer | null {
  try {
    const out = inflateSync(pack.subarray(offset, offset + length));
    return out.length === size ? out : null;
  } catch {
    return null;
  }
}

// Adler-32 of `data`, the zlib stream trailer: four bytes at the very end of
// every stream. Checking a candidate length against it proves the length is
// the exact stream end without a second, deliberately-failing inflate.
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  let index = 0;
  while (index < data.length) {
    const stop = Math.min(index + 5552, data.length);
    for (; index < stop; index += 1) {
      a += data[index] as number;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

async function inflateEntry(pack: Buffer, offset: number, end: number, size: number): Promise<{ data: Buffer; next: number }> {
  void end;
  const guess = streamLengthBySize.get(size);
  if (guess !== undefined && guess >= 5 && offset + guess <= pack.length) {
    const hit = tryInflate(pack, offset, guess, size);
    if (hit !== null && pack.readUInt32BE(offset + guess - 4) === adler32(hit)) {
      return { data: hit, next: offset + guess };
    }
  }
  const stream = createInflate();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve());
    stream.on('error', (err: Error) => reject(err));
    stream.end(pack.subarray(offset));
  });
  const data = Buffer.concat(chunks);
  if (data.length !== size) throw new PktError('pack entry size mismatch');
  const length = (stream as unknown as { bytesWritten: number }).bytesWritten;
  if (!(length > 0)) throw new PktError('pack entry stream did not report its length');
  streamLengthBySize.set(size, length);
  return { data, next: offset + length };
}

/**
 * Parse an incoming pack and store every object it carries, resolving
 * OFS_DELTA and REF_DELTA entries against the pack itself and the store
 * (thin packs). Throws PktError on a corrupt pack.
 */
export async function unpackPack(pack: Buffer): Promise<string[]> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new PktError('not a pack');
  }
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0), baseOffset: -1, baseOid: '' };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new PktError('ref-delta base truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new PktError('unknown pack type code');
    }
    const inflated = await inflateEntry(pack, offset, trailerStart, header.size);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolvedByOid = new Map<string, { type: ObjType; data: Buffer }>();
  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let baseType: ObjType;
      let baseData: Buffer;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new PktError('ofs-delta base missing');
        const base = resolve(baseEntry);
        baseType = base.type;
        baseData = base.data;
      } else {
        const known = resolvedByOid.get(entry.baseOid) ?? objects.get(entry.baseOid);
        if (known === undefined) throw new PktError('ref-delta base missing');
        baseType = known.type;
        baseData = known.data;
      }
      const data = applyDelta(baseData, entry.data);
      const oid = storeObject(baseType, data);
      resolvedByOid.set(oid, { type: baseType, data });
      return { type: baseType, data, oid };
    }
    const type = CODE_TYPE[entry.typeCode] as ObjType;
    const oid = storeObject(type, entry.data);
    resolvedByOid.set(oid, { type, data: entry.data });
    return { type, data: entry.data, oid };
  };
  const stored: string[] = [];
  for (const entry of raw) stored.push(resolve(entry).oid);
  return stored;
}

// ------------------------------------------------------------- fetch cache

// Per-repo response caches: the outer map is keyed by repository, so
// invalidating a repo on any mutation is one delete, never a key scan.
const fetchCache = new Map<string, Map<string, Buffer>>();
const lsRefsCache = new Map<string, Map<string, Buffer>>();

registerFetchCacheClearer((repo: Repo) => {
  fetchCache.delete(repo.fullName);
  lsRefsCache.delete(repo.fullName);
});

function repoCache(cache: Map<string, Map<string, Buffer>>, repo: Repo): Map<string, Buffer> {
  let inner = cache.get(repo.fullName);
  if (inner === undefined) {
    inner = new Map<string, Buffer>();
    cache.set(repo.fullName, inner);
  }
  return inner;
}

function fetchCacheKey(repo: Repo, protocol: string, wants: string[], haves: string[], shallow: string[], depth: number | null): string {
  const w = [...wants].sort().join(',');
  const h = [...haves].sort().join(',');
  const s = [...shallow].sort().join(',');
  return `${repo.version}|${protocol}|w=${w}|h=${h}|s=${s}|d=${depth === null ? 'full' : depth}`;
}

// ------------------------------------------------------------- advertisements

/** Sorted ref lines for an advertisement (HEAD handled by the caller). */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peeledLine(repo: Repo, ref: string, oid: string): string | null {
  const object = objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const currentObject = objects.get(current);
    if (currentObject === undefined || currentObject.type !== 'tag') break;
    current = parseTag(currentObject.data).object;
  }
  return `${current} ${ref}^{}\n`;
}

/** The v0 ref advertisement body shared by upload-pack (v0) and receive-pack. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities =
    service === 'git-upload-pack'
      ? 'side-band-64k symref=HEAD:refs/heads/main ofs-delta'
      : 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} HEAD\0${capabilities}\n`));
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\n`));
  } else {
    parts.push(pktLine(`${headTip} HEAD\0${capabilities}\n`));
    for (const [ref, oid] of sortedRefs(repo)) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peeled = peeledLine(repo, ref, oid);
      if (peeled !== null) parts.push(pktLine(peeled));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The protocol-v2 capability advertisement for upload-pack. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=github-core-clone/1.0\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done\n'),
  pktLine('object-format=sha1\n'),
  FLUSH,
]);

export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

// ---------------------------------------------------------------- ls-refs

export function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const cacheKey = `${repo.version}|${args.join(' ')}`;
  const cached = lsRefsCache.get(repo.fullName)?.get(cacheKey);
  if (cached !== undefined) return cached;
  const body = buildLsRefs(repo, args);
  repoCache(lsRefsCache, repo).set(cacheKey, body);
  return body;
}

function buildLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      parts.push(pktLine(symrefs ? `${headTip} HEAD symref-target:${headRef}\n` : `${headTip} HEAD\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${headRef}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        let current = oid;
        for (let guard = 0; guard < 32; guard += 1) {
          const currentObject = objects.get(current);
          if (currentObject === undefined || currentObject.type !== 'tag') break;
          current = parseTag(currentObject.data).object;
        }
        line += ` peeled:${current}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

/**
 * Every object reachable from the haves (the client's held set). A have that
 * is also a shallow boundary is a cut point: the client holds the commit and
 * its tree, but not its parents — so the walk does not descend past it.
 */
function haveObjectClosure(haves: readonly string[], shallowSet: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const meta = commitMeta.get(oid);
      if (meta !== undefined) {
        stack.push(meta.tree);
        if (!shallowSet.has(oid)) {
          for (const parent of meta.parents) stack.push(parent);
        }
      }
    } else if (object.type === 'tree') {
      // Tree entries are walked through the store's parser lazily here to
      // avoid importing it twice; trees are small in the fetch paths.
      let offset = 0;
      const data = object.data;
      while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space < 0) break;
        const nul = data.indexOf(0x00, space + 1);
        if (nul < 0 || nul + 21 > data.length) break;
        stack.push(data.subarray(nul + 1, nul + 21).toString('hex'));
        offset = nul + 21;
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Commit-only ancestry of the haves, cut at shallow boundaries like the object closure. */
function haveCommitClosure(haves: readonly string[], shallowSet: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const have of haves) {
    let current = have;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = objects.get(current);
      if (object === undefined) break;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') stack.push(current);
      break;
    }
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (shallowSet.has(oid)) continue;
    const meta = commitMeta.get(oid);
    if (meta !== undefined) for (const parent of meta.parents) stack.push(parent);
  }
  return seen;
}

interface FetchPlan {
  oids: string[];
  shallowLines: string[];
  hasShallowSection: boolean;
}

/**
 * Compute what a fetch delivers. Traversal is generation-bounded for shallow
 * requests (commits at generations 0..depth-1 from the wants, expanding
 * through held shallow boundaries so a deepen can reach the next
 * generation), and a single visited-set BFS for full fetches, pruning whole
 * ancestries at commits the client already holds.
 */
function planFetch(wants: string[], haves: string[], shallow: string[], depth: number | null): FetchPlan {
  const shallowSet = new Set(shallow);
  const haveObjects = haves.length > 0 ? haveObjectClosure(haves, shallowSet) : new Set<string>();
  const haveCommits = haves.length > 0 ? haveCommitClosure(haves, shallowSet) : new Set<string>();
  const delivered = new Set<string>();
  const deliveredCommits = new Set<string>();
  const commitGen = new Map<string, number>();

  const deliverTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (delivered.has(oid) || haveObjects.has(oid)) continue;
      const object = objects.get(oid);
      if (object === undefined || object.type !== 'tree') {
        if (object !== undefined && object.type === 'blob') delivered.add(oid);
        continue;
      }
      delivered.add(oid);
      let offset = 0;
      const data = object.data;
      while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space < 0) break;
        const nul = data.indexOf(0x00, space + 1);
        if (nul < 0 || nul + 21 > data.length) break;
        const mode = data.subarray(offset, space).toString('ascii');
        const child = data.subarray(nul + 1, nul + 21).toString('hex');
        if (mode === '40000') stack.push(child);
        else if (!delivered.has(child) && !haveObjects.has(child)) delivered.add(child);
        offset = nul + 21;
      }
    }
  };

  // Breadth-first by generation so the depth bound is exact.
  let frontier: string[] = [];
  const seedCommit = (oid: string, gen: number): void => {
    let current = oid;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = objects.get(current);
      if (object === undefined) return;
      if (object.type === 'tag') {
        if (!delivered.has(current) && !haveObjects.has(current)) delivered.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') {
        const known = commitGen.get(current);
        if (known === undefined || gen < known) {
          commitGen.set(current, gen);
          frontier.push(current);
        }
        return;
      }
      // A direct tree/blob want.
      if (!delivered.has(current) && !haveObjects.has(current)) delivered.add(current);
      return;
    }
  };
  for (const want of wants) seedCommit(want, 0);

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const commitOid of frontier) {
      const gen = commitGen.get(commitOid) as number;
      if (depth !== null && gen >= depth) continue;
      const meta = commitMeta.get(commitOid);
      if (meta === undefined) continue;
      const held = haveObjects.has(commitOid);
      if (!held) {
        delivered.add(commitOid);
        deliveredCommits.add(commitOid);
        deliverTree(meta.tree);
      }
      // Expansion: full fetches prune at held commits; depth-bounded fetches
      // expand through them (a held shallow boundary's parent is the point
      // of a deepen), bounded by the depth itself.
      const mayExpand = depth !== null || !held || shallowSet.has(commitOid);
      if (!mayExpand) continue;
      for (const parent of meta.parents) {
        const parentGen = gen + 1;
        if (depth !== null && parentGen > depth) continue;
        const known = commitGen.get(parent);
        if (known === undefined || parentGen < known) {
          commitGen.set(parent, parentGen);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  // Shallow bookkeeping.
  const shallowLines: string[] = [];
  const hasShallowSection = depth !== null || shallow.length > 0;
  if (hasShallowSection) {
    if (depth === null) {
      for (const boundary of shallow) shallowLines.push(`unshallow ${boundary}`);
    } else {
      const newBoundaries = new Set<string>();
      for (const commitOid of deliveredCommits) {
        const meta = commitMeta.get(commitOid);
        if (meta === undefined) continue;
        for (const parent of meta.parents) {
          if (!deliveredCommits.has(parent) && !haveCommits.has(parent)) newBoundaries.add(commitOid);
        }
        if (meta.parents.length === 0) {
          // A delivered root is not shallow.
        }
      }
      for (const boundary of newBoundaries) shallowLines.push(`shallow ${boundary}`);
      for (const boundary of shallow) {
        if (newBoundaries.has(boundary)) continue;
        const meta = commitMeta.get(boundary);
        const parentDelivered = meta !== undefined && meta.parents.some((parent) => deliveredCommits.has(parent));
        if (parentDelivered || (meta !== undefined && meta.parents.length === 0)) {
          shallowLines.push(`unshallow ${boundary}`);
        } else if (!deliveredCommits.has(boundary)) {
          shallowLines.push(`shallow ${boundary}`);
        }
      }
    }
  }

  return { oids: [...delivered], shallowLines, hasShallowSection };
}

/** Build the v2 fetch response body (acknowledgments, shallow-info, packfile). */
export function handleFetchV2(repo: Repo, args: string[]): Buffer | 'unknown-want' {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
  }
  for (const want of wants) {
    if (!isOid(want) || !objects.has(want)) return 'unknown-want';
  }
  const cacheKey = fetchCacheKey(repo, 'v2', wants, haves, shallow, depth);
  const cached = fetchCache.get(repo.fullName)?.get(cacheKey);
  if (cached !== undefined) return cached;

  const plan = planFetch(wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const presentHaves = haves.filter((have) => objects.has(have));
  if (presentHaves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of presentHaves) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(FLUSH);
  if (plan.hasShallowSection) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(buildPack(plan.oids)));
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  repoCache(fetchCache, repo).set(cacheKey, body);
  return body;
}

/** Build the v0 fetch response body (NAK/ACK lines then sideband pack). */
export function handleFetchV0(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null): Buffer | 'unknown-want' {
  for (const want of wants) {
    if (!isOid(want) || !objects.has(want)) return 'unknown-want';
  }
  const cacheKey = fetchCacheKey(repo, 'v0', wants, haves, shallow, depth);
  const cached = fetchCache.get(repo.fullName)?.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  const presentHaves = haves.filter((have) => objects.has(have));
  if (presentHaves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of presentHaves) parts.push(pktLine(`ACK ${have}\n`));
  }
  for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
  parts.push(sidebandWrap(buildPack(plan.oids)));
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  repoCache(fetchCache, repo).set(cacheKey, body);
  return body;
}

// ------------------------------------------------------------ receive-pack

/**
 * Fast-forward test with generation pruning: the direct-parent fast path
 * first, then a walk from `newOid` that never descends below the old tip's
 * generation. Never a full-history closure.
 */
export function isFastForward(oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const newMeta = commitMeta.get(newOid);
  const oldMeta = commitMeta.get(oldOid);
  if (newMeta === undefined || oldMeta === undefined) return false;
  if (newMeta.parents.includes(oldOid)) return true;
  const oldGen = oldMeta.gen;
  if (oldGen >= 0 && newMeta.gen >= 0 && newMeta.gen <= oldGen) return false;
  const seen = new Set<string>();
  const stack = [newOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const meta = commitMeta.get(oid);
    if (meta === undefined) continue;
    if (oldGen >= 0 && meta.gen >= 0 && meta.gen < oldGen) continue;
    for (const parent of meta.parents) stack.push(parent);
  }
  return false;
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Run a receive-pack exchange: unpack first (objects are stored even for a
 * refused update), then validate and apply each ref command in order.
 * Returns the sideband-framed report-status body.
 */
export async function handleReceivePack(repo: Repo, commands: PushCommand[], pack: Buffer): Promise<Buffer> {
  let unpackOk = true;
  if (pack.length > 0) {
    try {
      await unpackPack(pack);
      touchRepo(repo);
    } catch {
      unpackOk = false;
    }
  }
  const lines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    const current = repo.refs.get(ref);
    let ok = false;
    let reason = 'non-fast-forward';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (newOid === ZERO_OID) {
      // Delete: the ref must exist and the named old tip must match.
      if (current !== undefined && current === oldOid) {
        repo.refs.delete(ref);
        repo.branchFiles.delete(ref);
        ok = true;
      } else if (current === undefined) {
        reason = 'reference does not exist';
      }
    } else if (oldOid === ZERO_OID) {
      // Create: the ref must not exist yet.
      if (current !== undefined) {
        reason = 'already exists';
      } else if (!objects.has(newOid)) {
        reason = 'non-fast-forward';
      } else {
        repo.refs.set(ref, newOid);
        ok = true;
      }
    } else {
      // Update: old must be the current tip and new its descendant.
      if (current === undefined) {
        reason = 'reference does not exist';
      } else if (current !== oldOid) {
        reason = 'non-fast-forward';
      } else if (newOid === oldOid) {
        ok = true;
      } else {
        const newObject = objects.get(newOid);
        const oldObject = objects.get(oldOid);
        if (newObject !== undefined && oldObject !== undefined && newObject.type !== 'commit' && oldObject.type !== 'commit') {
          repo.refs.set(ref, newOid);
          ok = true;
        } else if (isFastForward(oldOid, newOid)) {
          repo.refs.set(ref, newOid);
          ok = true;
        }
      }
    }
    if (ok) {
      lines.push(`ok ${ref}\n`);
      touchRepo(repo);
    } else {
      lines.push(`ng ${ref} ${reason}\n`);
    }
  }
  const inner = Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH]);
  return sidebandWrap(inner);
}

/** SHA-1 helper kept for the advertisement paths that need a digest. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
