/**
 * TRA-1912: negative cache for deterministically-unindexable files.
 *
 * A live growing file past the size cap (e.g. an app's append-only `.jsonl`
 * scratchpad) re-fires the watcher on every append. Without this gate each
 * event ran a full doomed pipeline — reindex lock + whole-file read + error
 * count — only for `FileExtractor` to reject it again (~480 such pipelines
 * for one 14 MB file in 51 minutes). The same holds for a hot binary journal
 * (`*.session-journal`): every append re-ran the pipeline for a `skipped`.
 *
 * `checkUnindexableSkip()` answers from one stat (taken by the caller) plus
 * at most one 8 KB head read, before the pipeline lock — no DB, no full
 * read. It mirrors the extractor's gates exactly (1 MB default cap, 5 MB
 * hard ceiling for `package.json#main`/`module`/`bin`/`exports` entries,
 * `isBinaryBuffer` verdict), so a path dropped here is a path the extractor
 * would have rejected anyway.
 *
 * Cache discipline:
 * - `oversize` holds regardless of growth: any current size above the cap is
 *   still doomed, so the verdict needs no size+mtime comparison — it clears
 *   only when the file shrinks back under the cap (or disappears).
 * - `binary` is always re-probed (≤ 8 KB head read): a size+mtime-only
 *   negative cache goes stale on coarse-mtime filesystems (Windows: a
 *   same-size rewrite inside one mtime tick keeps the old stat, so the
 *   cached verdict outlives the content — TRA-1919). The head read is
 *   microseconds next to the doomed pipeline it replaces, and the pipeline
 *   already budgets "one stat plus at most one 8 KB head read" per path.
 *
 * Bounded on both axes like `recent-reindex-cache.ts`: ≤ 256 verdicts per
 * root (coldest evicted first — hot growing files re-record on every event
 * and stay alive), ≤ 64 roots. First occurrence per (root, path, reason)
 * keeps the full warn with the extractor's message so log parsers keep
 * working; repeats go to debug (TRA-1841 shape).
 */
import fs from 'node:fs';
import { logger } from '../logger.js';
import { DEFAULT_MAX_FILE_SIZE, isBinaryBuffer } from '../utils/security.js';
import { findPackageJsonEntries } from './package-entries.js';

export type UnindexableReason = 'oversize' | 'binary';

/**
 * Force-included package entries keep the extractor's 5 MB hard ceiling —
 * above it even a declared entry is treated as an artifact, not source.
 */
const FORCE_INCLUDE_HARD_CEILING = 5 * 1024 * 1024;

/** Matches `isBinaryBuffer`'s sampling window — never read more than this. */
const BINARY_PROBE_BYTES = 8192;

const MAX_ROOTS = 64;
const MAX_ENTRIES_PER_ROOT = 256;

/** `package.json` entry sets go stale fast (a new `main` must take effect). */
const FORCE_INCLUDE_TTL_MS = 60_000;
const MAX_FORCE_INCLUDE_ROOTS = 64;

/** Bound on distinct warn keys; beyond it the set resets (DoS-safe). */
const MAX_WARN_KEYS = 1000;

interface Verdict {
  reason: UnindexableReason;
  size: number;
  mtimeMs: number;
}

/** rootPath → relPosix → last unindexable verdict. */
const verdicts = new Map<string, Map<string, Verdict>>();

/** rootPath → cached `package.json` entry set. */
const forceIncludeCache = new Map<string, { entries: Set<string>; computedAt: number }>();

const warned = new Set<string>();

function verdictKey(rootPath: string, relPosix: string, reason: UnindexableReason): string {
  return `${rootPath}\n${relPosix}\n${reason}`;
}

function logOnce(
  rootPath: string,
  relPosix: string,
  reason: UnindexableReason,
  meta: Record<string, unknown>,
  message: string,
): void {
  const key = verdictKey(rootPath, relPosix, reason);
  if (warned.has(key)) {
    logger.debug({ file: relPosix }, `${message} (repeat suppressed)`);
    return;
  }
  if (warned.size >= MAX_WARN_KEYS) warned.clear();
  warned.add(key);
  logger.warn(meta, message);
}

function recordVerdict(rootPath: string, relPosix: string, verdict: Verdict): void {
  let bucket = verdicts.get(rootPath);
  if (!bucket) {
    bucket = new Map();
    if (verdicts.size >= MAX_ROOTS) {
      const lru = verdicts.keys().next().value;
      if (lru !== undefined && lru !== rootPath) verdicts.delete(lru);
    }
    verdicts.set(rootPath, bucket);
  } else {
    // LRU bump: the active set stays hot under load.
    verdicts.delete(rootPath);
    verdicts.set(rootPath, bucket);
  }
  // Re-setting refreshes insertion order, so a hot growing file is never
  // the coldest entry when the bucket overflows below.
  bucket.set(relPosix, verdict);
  while (bucket.size > MAX_ENTRIES_PER_ROOT) {
    const coldest = bucket.keys().next().value;
    if (coldest === undefined) break;
    bucket.delete(coldest);
  }
}

function dropVerdict(rootPath: string, relPosix: string): void {
  verdicts.get(rootPath)?.delete(relPosix);
}

/**
 * Package entry set for `rootPath`, memoized. The underlying walk touches
 * every directory, so it runs at most once per TTL per root — and only when
 * an actually-oversized file needs the force-include decision. Normal-size
 * files never pay for it.
 */
function getForceIncludeSet(rootPath: string): ReadonlySet<string> {
  const now = Date.now();
  const cached = forceIncludeCache.get(rootPath);
  if (cached && now - cached.computedAt < FORCE_INCLUDE_TTL_MS) {
    return cached.entries;
  }
  const entries = findPackageJsonEntries(rootPath);
  if (forceIncludeCache.size >= MAX_FORCE_INCLUDE_ROOTS) {
    const lru = forceIncludeCache.keys().next().value;
    if (lru !== undefined && lru !== rootPath) forceIncludeCache.delete(lru);
  }
  forceIncludeCache.set(rootPath, { entries, computedAt: now });
  return entries;
}

function probeBinary(absPath: string, size: number): boolean | null {
  // Unreadable here is not a verdict — leave the path for the extractor's
  // read path, which logs the cause with root + errno (TRA-1715).
  let fd: number;
  try {
    fd = fs.openSync(absPath, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return isBinaryBuffer(buf.subarray(0, n));
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort close */
    }
  }
}

export interface UnindexableCheck {
  rootPath: string;
  /** Project-relative path with forward slashes (the index's spelling). */
  relPosix: string;
  absPath: string;
  /** From the caller's stat — no second syscall. */
  size: number;
  mtimeMs: number;
}

/**
 * Cheap pre-pipeline gate. Returns the skip reason when the extractor would
 * deterministically reject this file, `null` when the pipeline must run.
 * Never throws for filesystem races: doubt resolves to `null` (run it).
 */
export function checkUnindexableSkip(check: UnindexableCheck): UnindexableReason | null {
  const { rootPath, relPosix, absPath, size, mtimeMs } = check;

  // Size gate first: above the cap no content verdict matters. The
  // force-include set is consulted only in the (1 MB, 5 MB] band — above
  // the hard ceiling even a declared entry is dropped, no walk needed.
  let limit = DEFAULT_MAX_FILE_SIZE;
  if (size > limit) {
    if (size <= FORCE_INCLUDE_HARD_CEILING && getForceIncludeSet(rootPath).has(relPosix)) {
      limit = FORCE_INCLUDE_HARD_CEILING;
    }
    if (size > limit) {
      recordVerdict(rootPath, relPosix, { reason: 'oversize', size, mtimeMs });
      logOnce(
        rootPath,
        relPosix,
        'oversize',
        { file: relPosix, size, limit },
        'File too large, skipping',
      );
      return 'oversize';
    }
  }
  // Under the cap a stale oversize verdict must not survive the shrink —
  // the file became indexable again.
  const stale = verdicts.get(rootPath)?.get(relPosix);
  if (stale?.reason === 'oversize') dropVerdict(rootPath, relPosix);

  // Binary gate: always re-probe the ≤ 8 KB head. A size+mtime negative
  // cache is unsound here — on coarse-mtime filesystems (Windows) a
  // same-size rewrite inside one mtime tick keeps the old stat, so a
  // cached 'binary' would outlive rotated-into-text content (TRA-1919).
  // The probe is microseconds next to the doomed pipeline it replaces.
  const cached = verdicts.get(rootPath)?.get(relPosix);
  const binary = probeBinary(absPath, size);
  if (binary === null) return null;
  if (!binary) {
    if (cached?.reason === 'binary') dropVerdict(rootPath, relPosix);
    return null;
  }
  recordVerdict(rootPath, relPosix, { reason: 'binary', size, mtimeMs });
  logOnce(rootPath, relPosix, 'binary', { file: relPosix }, 'Binary file detected, skipping');
  return 'binary';
}

/** Test hook — clears verdicts, warn gates, and the entry-set cache. */
export function resetUnindexableSkipCacheForTests(): void {
  verdicts.clear();
  forceIncludeCache.clear();
  warned.clear();
}

/** Test hook — inspect bookkeeping (bounds). */
export function __unindexableSkipCacheStats(): {
  roots: number;
  totalEntries: number;
  maxRoots: number;
  maxEntriesPerRoot: number;
} {
  let total = 0;
  for (const b of verdicts.values()) total += b.size;
  return {
    roots: verdicts.size,
    totalEntries: total,
    maxRoots: MAX_ROOTS,
    maxEntriesPerRoot: MAX_ENTRIES_PER_ROOT,
  };
}
