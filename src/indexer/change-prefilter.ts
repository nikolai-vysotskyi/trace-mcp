/**
 * TRA-1536 — mtime+size change prefilter.
 *
 * `docs/perf/index-throughput.md` §5: every incremental run calls `extract()`
 * once per file in the whole corpus (1903 calls for a 1-file change) so the
 * content-hash gate can decide which ones actually changed. The per-file
 * dispatch (worker IPC round-trip or in-process extract with its
 * validatePath/lstat/matcher overhead) costs ~331 ms/8 wall-share — comparable
 * to edge resolution — just to enumerate "did anything change".
 *
 * This module answers that question up front on the main thread with one
 * `lstatSync` per file against the already-preloaded `existingFiles` map (one
 * IN-query, no per-file SELECT). Files whose mtime floor AND byte size both
 * match the stored row are provably unchanged and never reach `extract()`; everything
 * else (new files, mtime drift, size drift, missing/symlink/dir, legacy rows
 * without mtime) passes through to the normal extract path, which keeps its
 * own read+hash gate for the mtime-drifted-but-identical case.
 *
 * Conservative by construction: the prefilter may only turn "skip" into
 * "extract", never the reverse of what `extract()` itself would decide —
 * except for the exact mtime+size-match case where `extract()` would also
 * skip (its mtime fast-path, now additionally size-hardened). A same-ms-floor
 * rewrite that also keeps the byte size is undetectable without reading and
 * is documented as such; a same-floor rewrite that changes the size IS
 * caught here (and in `extract()`'s hardened fast-path).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FileRow } from '../db/types.js';

export interface ChangePrefilterResult {
  /** Files that may have changed — the only ones `extract()` must see. */
  candidates: string[];
  /** Files proven unchanged by mtime+size (caller adds to `result.skipped`). */
  skipped: number;
}

/**
 * Split `relPaths` into extract candidates vs. provably-unchanged files.
 * Pure + synchronous; never touches the DB or the file contents.
 */
export function selectChangedFiles(
  rootPath: string,
  relPaths: string[],
  existingFiles: Map<string, FileRow>,
  force: boolean,
): ChangePrefilterResult {
  // force=true means "re-extract everything" — the predicate is bypassed
  // entirely, same as extract()'s own `force` handling.
  if (force) return { candidates: relPaths.slice(), skipped: 0 };
  const candidates: string[] = [];
  let skipped = 0;
  for (const relPath of relPaths) {
    if (isUnchangedByStat(rootPath, relPath, existingFiles.get(relPath))) {
      skipped++;
    } else {
      candidates.push(relPath);
    }
  }
  return { candidates, skipped };
}

/**
 * True only when the stored row proves the file cannot have changed:
 * mtime floor matches AND (no stored size OR stored size matches).
 * Everything else — no row, no stored mtime, stat failure, symlink,
 * directory, mtime drift, size drift — returns false (extract it).
 */
export function isUnchangedByStat(
  rootPath: string,
  relPath: string,
  existing: FileRow | undefined,
): boolean {
  if (!existing || existing.mtime_ms == null) return false;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path.resolve(rootPath, relPath));
  } catch {
    // Missing/unreadable — leave for extract()'s normal error path.
    return false;
  }
  if (stat.isSymbolicLink() || stat.isDirectory()) return false;
  if (existing.mtime_ms !== Math.floor(stat.mtimeMs)) return false;
  // Size is the second factor: a rewrite inside the same mtime-ms floor
  // with a different length must NOT skip (extract()'s mtime-only fast-path
  // would miss it — see the hardened check there). Legacy rows without a
  // stored size fall back to the mtime-only verdict.
  if (existing.byte_length != null && existing.byte_length !== stat.size) return false;
  return true;
}
