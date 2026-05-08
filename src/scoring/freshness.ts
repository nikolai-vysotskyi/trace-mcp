/**
 * Per-result freshness signals for retrieval responses.
 *
 * Compares the on-disk mtime of a file against the mtime captured at index time.
 * Lets agents distinguish trustworthy results from results pointing at stale or
 * since-edited files without re-reading the source.
 *
 * Values:
 *   - 'fresh':                file mtime ≤ index mtime (or no mtime tracked) → result reflects current code
 *   - 'edited_uncommitted':   file mtime > index mtime → file was edited after indexing, result may be stale
 *   - 'stale_index':          file is missing from disk or unreadable → index references something gone
 *
 * Not (yet) covered: git HEAD vs index_sha. That requires a `repo_metadata` table
 * with a recorded HEAD SHA at index time. Wire in later via {@link computeRepoFreshness}.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import type { FileRow } from '../db/types.js';

export type FreshnessLevel = 'fresh' | 'edited_uncommitted' | 'stale_index';

export interface FreshnessSummary {
  fresh: number;
  edited_uncommitted: number;
  stale_index: number;
  /** True if any entry is not 'fresh' — quick gate for agents to decide whether to reindex. */
  repo_is_stale: boolean;
}

interface FreshnessSignals {
  /** Index-recorded mtime in ms (floored). Null when the indexer didn't capture it. */
  indexedMtimeMs: number | null;
  /** Absolute path used to stat the file. */
  absolutePath: string;
}

/**
 * Compute the freshness of a single file by comparing on-disk mtime to indexed mtime.
 * Pure (no side effects beyond a single statSync). Returns 'fresh' as the safe default
 * when freshness cannot be determined (no indexed mtime).
 */
export function computeFileFreshness(
  rootPath: string,
  file: Pick<FileRow, 'path' | 'mtime_ms'>,
): FreshnessLevel {
  return computeFileFreshnessFromSignals({
    indexedMtimeMs: file.mtime_ms,
    absolutePath: path.resolve(rootPath, file.path),
  });
}

/** Inner pure function — splits the IO from the comparison so tests can inject signals. */
export function computeFileFreshnessFromSignals(signals: FreshnessSignals): FreshnessLevel {
  let currentMtimeMs: number;
  try {
    currentMtimeMs = fs.statSync(signals.absolutePath).mtimeMs;
  } catch {
    return 'stale_index';
  }

  if (signals.indexedMtimeMs == null) {
    // No baseline → assume fresh; a missing baseline is a property of older indexes,
    // not evidence of drift.
    return 'fresh';
  }

  // Indexer floors mtime when storing (file-extractor.ts), so floor here too.
  if (Math.floor(currentMtimeMs) > signals.indexedMtimeMs) {
    return 'edited_uncommitted';
  }
  return 'fresh';
}

/**
 * Aggregate per-entry freshness levels into a summary suitable for `_meta.freshness`.
 * Agents can read `repo_is_stale` to decide whether to call `register_edit` / `reindex`.
 */
export function aggregateFreshness(levels: Iterable<FreshnessLevel>): FreshnessSummary {
  const summary: FreshnessSummary = {
    fresh: 0,
    edited_uncommitted: 0,
    stale_index: 0,
    repo_is_stale: false,
  };
  for (const level of levels) {
    summary[level] += 1;
  }
  summary.repo_is_stale = summary.edited_uncommitted + summary.stale_index > 0;
  return summary;
}

/**
 * Batch-resolve freshness for a set of file paths. Each path is statted once.
 * Files unknown to the index get `'fresh'` as a safe default (the file exists on disk
 * but we have no baseline to compare against — treating it as fresh keeps the agent
 * from spuriously distrusting unindexed-but-existing files).
 */
export function resolveFreshnessForPaths(
  store: Store,
  rootPath: string,
  filePaths: Iterable<string>,
): Map<string, FreshnessLevel> {
  const out = new Map<string, FreshnessLevel>();
  const unique = new Set<string>();
  for (const p of filePaths) {
    if (typeof p === 'string' && p.length > 0) unique.add(p);
  }
  if (unique.size === 0) return out;

  const fileRows = store.getFilesByPaths(Array.from(unique));
  for (const filePath of unique) {
    const row = fileRows.get(filePath);
    const level: FreshnessLevel = row
      ? computeFileFreshness(rootPath, row)
      : computeFileFreshnessFromSignals({
          indexedMtimeMs: null,
          absolutePath: path.resolve(rootPath, filePath),
        });
    out.set(filePath, level);
  }
  return out;
}

/**
 * Attach `_freshness` to each item in a list whose `file` field is a relative path.
 * Returns the enriched items and an aggregated summary suitable for `_meta.freshness`.
 */
export function enrichItemsWithFreshness<T extends { file: string }>(
  store: Store,
  rootPath: string,
  items: T[],
): { items: (T & { _freshness: FreshnessLevel })[]; summary: FreshnessSummary } {
  const map = resolveFreshnessForPaths(
    store,
    rootPath,
    items.map((i) => i.file),
  );
  const enriched = items.map((item) => ({
    ...item,
    _freshness: map.get(item.file) ?? 'fresh',
  }));
  return { items: enriched, summary: aggregateFreshness(enriched.map((i) => i._freshness)) };
}

/**
 * Repo-level staleness: compares the git HEAD captured at index time
 * (`repo_metadata.index_head_sha`) with the current `git rev-parse HEAD`.
 * When they differ, every result in the response is potentially behind the
 * working tree and the agent should consider re-indexing.
 *
 * Returns null when:
 *   - the repo isn't a git working tree, or
 *   - git is unavailable, or
 *   - no HEAD was recorded at index time (older index format).
 *
 * Best-effort: any failure resolves to null so freshness reporting never blocks.
 */
import { execSync as _execSync } from 'node:child_process';
import { safeGitEnv } from '../utils/git-env.js';

export function computeRepoFreshness(
  rootPath: string,
  store: Pick<Store, 'getRepoMetadata'>,
): { index_head_sha: string; current_head_sha: string; repo_is_stale: boolean } | null {
  let indexed: string | null;
  try {
    indexed = store.getRepoMetadata('index_head_sha');
  } catch {
    return null;
  }
  if (!indexed) return null;

  let current: string | null = null;
  try {
    const out = _execSync('git rev-parse HEAD', {
      cwd: rootPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      env: safeGitEnv(),
    });
    const sha = out.trim();
    if (/^[0-9a-f]{40}$/.test(sha)) current = sha;
  } catch {
    return null;
  }
  if (!current) return null;

  return {
    index_head_sha: indexed,
    current_head_sha: current,
    repo_is_stale: indexed !== current,
  };
}
