/**
 * Per-project, per-file recent-reindex tracker. Used to dedup the
 * concurrent (PostToolUse hook + register_edit MCP tool) reindex of
 * the same file caused by a single Edit/Write.
 *
 * TTL is intentionally tight (~500 ms): long enough to absorb the
 * round-trip skew between the two paths, short enough that real
 * subsequent edits are never silently dropped.
 *
 * Bounded on both axes:
 *   - inner bucket: ≤ 256 file entries, GC'd opportunistically on insert
 *   - outer map:    ≤ 64 projects, drops the least-recently-used project
 *                   when overflowing. An LRU bump on every lookup keeps
 *                   the active set hot.
 *
 * Without these bounds a long-lived daemon servicing many distinct
 * projects (federation / cross-repo workflows) accumulates one bucket
 * per project for the lifetime of the process and never frees them —
 * each lookup hits a sub-map that itself can hold up to 256 stale
 * paths. With the bounds the memory ceiling is O(64 × 256) entries,
 * roughly 16k tiny rows.
 */
const TTL_MS = 500;
const MAX_PROJECTS = 64;
const MAX_BUCKET_SIZE = 256;

const buckets = new Map<string, Map<string, number>>();

function bumpLruProject(project: string, bucket: Map<string, number>): void {
  // Map iteration = insertion order, so delete+set bumps to MRU.
  buckets.delete(project);
  buckets.set(project, bucket);
}

function sweepBucket(bucket: Map<string, number>, now: number): void {
  for (const [p, t] of bucket) {
    if (now - t >= TTL_MS) bucket.delete(p);
  }
}

/** Returns true if this (project, path) was reindexed within TTL_MS. Also bumps the timestamp. */
export function shouldSkipRecentReindex(
  project: string,
  filePath: string,
  now = Date.now(),
): boolean {
  let bucket = buckets.get(project);
  if (!bucket) {
    bucket = new Map();
    // Cap the outer map. Drop the LRU project rather than the one we're
    // about to insert — that preserves the active set under load.
    if (buckets.size >= MAX_PROJECTS) {
      const lru = buckets.keys().next().value;
      if (lru !== undefined && lru !== project) buckets.delete(lru);
    }
    buckets.set(project, bucket);
  } else {
    bumpLruProject(project, bucket);
  }
  const last = bucket.get(filePath);
  if (last !== undefined && now - last < TTL_MS) {
    return true;
  }
  bucket.set(filePath, now);
  if (bucket.size > MAX_BUCKET_SIZE) {
    sweepBucket(bucket, now);
  }
  return false;
}

/** Drop all cache entries for a project (called when project is removed from the daemon). */
export function clearProjectReindexCache(project: string): void {
  buckets.delete(project);
}

/** Test-only: reset all state. */
export function __resetRecentReindexCache(): void {
  buckets.clear();
}

/** Test-only: inspect bookkeeping. */
export function __recentReindexCacheStats(): {
  projects: number;
  totalEntries: number;
  maxProjects: number;
  maxBucketSize: number;
} {
  let total = 0;
  for (const b of buckets.values()) total += b.size;
  return {
    projects: buckets.size,
    totalEntries: total,
    maxProjects: MAX_PROJECTS,
    maxBucketSize: MAX_BUCKET_SIZE,
  };
}
