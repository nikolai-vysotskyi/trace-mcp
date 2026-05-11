/**
 * Per-project, per-file recent-reindex tracker. Used to dedup the
 * concurrent (PostToolUse hook + register_edit MCP tool) reindex of
 * the same file caused by a single Edit/Write.
 *
 * TTL is intentionally tight (~500 ms): long enough to absorb the
 * round-trip skew between the two paths, short enough that real
 * subsequent edits are never silently dropped.
 */
const TTL_MS = 500;

const buckets = new Map<string, Map<string, number>>();

/** Returns true if this (project, path) was reindexed within TTL_MS. Also bumps the timestamp. */
export function shouldSkipRecentReindex(
  project: string,
  filePath: string,
  now = Date.now(),
): boolean {
  let bucket = buckets.get(project);
  if (!bucket) {
    bucket = new Map();
    buckets.set(project, bucket);
  }
  const last = bucket.get(filePath);
  if (last !== undefined && now - last < TTL_MS) {
    return true;
  }
  bucket.set(filePath, now);
  if (bucket.size > 256) {
    for (const [p, t] of bucket) {
      if (now - t >= TTL_MS) bucket.delete(p);
    }
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
