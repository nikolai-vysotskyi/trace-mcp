/**
 * ObservationPack port — SoL-Pi → trace-mcp (TRA-1700).
 *
 * MIT attribution: paging/verify logic ported from NVlabs/SoL-Pi
 * `src/sol-pi/extensions/observation-pack/observation.ts` (ensureStored,
 * content-addressed id, symlink refusal + hash-verify on reuse, fail-open).
 *
 * Harness-agnostic adaptation: Pi projects large results through `on("context")`
 * transparently; the MCP server is stateless per request, so we store the full
 * payload content-addressed under TRACE_MCP_HOME and return an explicit handle
 * (`obs_<24hex>`) + paged recall instead of a silent projection.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TRACE_MCP_HOME } from './global.js';

/** Only payloads larger than this are worth packing (same default as SoL-Pi). */
export const OBSERVATION_THRESHOLD_BYTES = 10 * 1024;

/** First page size for packed dependents (matches MAX_EMITTED_DEPENDENTS). */
export const OBSERVATION_FIRST_PAGE_ITEMS = 25;

/** Hard cap on one recall page (same order as SoL-Pi's 16KB/400-line cap). */
export const OBSERVATION_RECALL_MAX_ITEMS = 500;

const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/;

export function isObservationId(id: string): boolean {
  return OBSERVATION_ID_PATTERN.test(id);
}

/**
 * Parse a recall handle with optional page cursor (`obs_<24hex>@25`).
 * The whole string must match — trailing garbage (`@25@99`, `@abc`) is
 * rejected rather than silently truncated. Throws `Unknown observation id`.
 */
export function parseBundleHandle(bundle: string): { id: string; offset: number } {
  const match = /^(obs_[a-f0-9]{24})(?:@(\d+))?$/.exec(bundle);
  const id = match?.[1] ?? '';
  const offset = match?.[2] === undefined ? 0 : Number(match[2]);
  if (!isObservationId(id) || !Number.isSafeInteger(offset)) {
    throw new Error(`Unknown observation id: ${bundle}`);
  }
  return { id, offset };
}

export function observationPackRoot(home: string = TRACE_MCP_HOME): string {
  return path.join(home, 'observation-pack', 'objects');
}

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Stable handle for a stored payload. Binds tool + query key + content hash so
 * two different queries over identical bytes do not collide.
 */
export function observationId(tool: string, queryKey: string, payloadJson: string): string {
  const contentHash = sha256Hex(payloadJson);
  return `obs_${sha256Hex(`${tool}\0${queryKey}\0${contentHash}`).slice(0, 24)}`;
}

export function observationPath(root: string, id: string): string {
  return path.join(root, `${id}.json`);
}

/**
 * Refuse symlinked (or non-file) objects before touching them. Node's
 * `writeFileSync`/`readFileSync` follow links, so the check is an explicit
 * `lstat` — same barrier SoL-Pi builds with `O_NOFOLLOW`. A missing path is
 * fine (store path); anything present-but-not-a-file throws. TOCTOU between
 * check and use is accepted: the pack dir is 0700 under TRACE_MCP_HOME, so a
 * planter already owns the trust boundary, and a foreign target still fails
 * the content-hash / JSON-shape checks below.
 */
function assertRegularFileOrAbsent(filePath: string, id: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Stored observation is not a regular file for ${id}`);
  }
}

export interface StoredObservation {
  id: string;
  bytes: number;
  totalItems: number;
  path: string;
}

/**
 * Store the full dependents payload (sync; payloads are < few MB).
 * Reuses an existing object only after byte-for-byte hash verification.
 * Throws on any filesystem anomaly — callers must fail open to the full answer.
 */
export function storeObservation(
  tool: string,
  queryKey: string,
  dependents: unknown[],
  root: string = observationPackRoot(),
): StoredObservation {
  if (!root) throw new Error('Persistent observation-pack directory is unavailable');
  const payloadJson = JSON.stringify({ tool, queryKey, dependents });
  const bytes = Buffer.byteLength(payloadJson, 'utf8');
  const id = observationId(tool, queryKey, JSON.stringify(dependents));
  const dir = root;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Observation directory is not a regular directory for ${id}`);
  }
  const filePath = observationPath(dir, id);
  assertRegularFileOrAbsent(filePath, id);
  try {
    fs.writeFileSync(filePath, payloadJson, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    assertRegularFileOrAbsent(filePath, id);
    const existing = fs.readFileSync(filePath, 'utf8');
    if (sha256Hex(existing) !== sha256Hex(payloadJson)) {
      throw new Error(`Content-addressed observation hash mismatch for ${id}`);
    }
  }
  return { id, bytes, totalItems: dependents.length, path: filePath };
}

export interface RecallPage<T = unknown> {
  id: string;
  items: T[];
  offset: number;
  nextOffset: number;
  eof: boolean;
  total: number;
}

/**
 * Recall one page of a stored dependents array by item offset.
 * Throws `Unknown observation id` on missing/mismatched/corrupt archives —
 * the caller maps that to "re-run the query" rather than fabricating data.
 */
export function recallObservation<T = unknown>(
  id: string,
  offset: number,
  limit: number,
  root: string = observationPackRoot(),
): RecallPage<T> {
  if (!isObservationId(id)) throw new Error(`Unknown observation id: ${id}`);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid offset: ${offset}`);
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), OBSERVATION_RECALL_MAX_ITEMS);
  const filePath = observationPath(root, id);
  try {
    assertRegularFileOrAbsent(filePath, id);
  } catch {
    // Missing, symlinked, or otherwise unusable archive: nothing truthful to
    // serve, so the caller re-runs the query instead of getting half a page.
    throw new Error(`Unknown observation id: ${id}`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`Unknown observation id: ${id}`);
    }
    throw error;
  }
  let parsed: { dependents?: unknown[] };
  try {
    parsed = JSON.parse(raw) as { dependents?: unknown[] };
  } catch {
    throw new Error(`Unknown observation id: ${id}`);
  }
  if (!parsed || !Array.isArray(parsed.dependents))
    throw new Error(`Unknown observation id: ${id}`);
  if (offset > parsed.dependents.length) {
    throw new Error(`Offset ${offset} exceeds observation size ${parsed.dependents.length}`);
  }
  const items = parsed.dependents.slice(offset, offset + safeLimit) as T[];
  const nextOffset = offset + items.length;
  return {
    id,
    items,
    offset,
    nextOffset,
    eof: nextOffset >= parsed.dependents.length,
    total: parsed.dependents.length,
  };
}

/** Pure slice helper shared by the MCP wiring and tests. */
export function pageItems<T>(
  items: T[],
  offset: number,
  limit: number,
): { page: T[]; nextOffset: number; eof: boolean } {
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return { page, nextOffset, eof: nextOffset >= items.length };
}
