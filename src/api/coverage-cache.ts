/**
 * In-memory cache for project technology coverage calculations (TRA-2928).
 * Avoids repeated synchronous filesystem traversals and manifest analyses
 * on repeated GET /api/projects/coverage calls.
 */

export interface CachedCoverage {
  coverage: {
    total_significant: number;
    covered: number;
    coverage_pct: number;
  };
  gaps: Array<{
    name: string;
    version: string;
    category: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  unknown: Array<{
    name: string;
    version: string;
    ecosystem: string;
    language_fallback: boolean;
    needs_plugin: 'likely' | 'maybe' | 'no';
    reason: string;
  }>;
  cachedAt: number;
}

const COVERAGE_CACHE_TTL_MS = 60_000; // 60 seconds TTL
const cache = new Map<string, CachedCoverage>();

export function getCachedCoverage(projectRoot: string): CachedCoverage | undefined {
  const entry = cache.get(projectRoot);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > COVERAGE_CACHE_TTL_MS) {
    cache.delete(projectRoot);
    return undefined;
  }
  return entry;
}

export function setCachedCoverage(
  projectRoot: string,
  data: Omit<CachedCoverage, 'cachedAt'>,
): void {
  cache.set(projectRoot, {
    ...data,
    cachedAt: Date.now(),
  });
}

export function invalidateCoverageCache(projectRoot?: string): void {
  if (projectRoot) {
    cache.delete(projectRoot);
  } else {
    cache.clear();
  }
}
