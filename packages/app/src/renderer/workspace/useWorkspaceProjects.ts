/**
 * useWorkspaceProjects — data hook for the unified Workspace tab.
 *
 * Composes `useDaemon()` (live SSE + mutations) with the dashboard health
 * endpoint (`GET /api/dashboard/projects`) into a single observable list of
 * merged {@link ProjectViewModel}s. See `./types.ts` for merge precedence
 * and `./README.md` for the design rationale.
 *
 * Cache invalidation: when any daemon project transitions out of a transient
 * pipeline state (indexing / embedding / computing / pending → ready /
 * error), schedule a debounced re-fetch of metrics. Plus a 5-minute polling
 * fallback that matches the server-side cache TTL.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDaemon } from '../hooks/useDaemon';
import {
  type ProjectHealthMetrics,
  type ProjectViewModel,
  mergeIntoViewModel,
} from './types';

const BASE = 'http://127.0.0.1:3741';

export const AUTO_REFRESH_INTERVAL_MS = 300_000; // 5 min — matches backend cache TTL.
export const STATUS_TRANSITION_DEBOUNCE_MS = 1000;

// ── Exported pure helpers (testable without React) ────────────────────────

/**
 * Returns true when `prev` was a transient pipeline status and `next` is a
 * terminal status — meaning dashboard metrics are now stale and should be
 * re-fetched.
 */
export function isCompletionTransition(prev: string | undefined, next: string): boolean {
  const transient = new Set(['indexing', 'embedding', 'computing', 'pending']);
  const terminal = new Set(['ready', 'ok', 'error']);
  return prev !== undefined && transient.has(prev) && terminal.has(next);
}

/**
 * Diff two daemon-status snapshots (keyed by project root). Returns true if
 * any project transitioned from transient → terminal between them.
 */
export function detectCompletionInDiff(
  prevByRoot: Map<string, string>,
  curr: Array<{ root: string; status: string }>,
): boolean {
  for (const p of curr) {
    if (isCompletionTransition(prevByRoot.get(p.root), p.status)) return true;
  }
  return false;
}

export interface UseWorkspaceProjectsResult {
  projects: ProjectViewModel[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  connected: boolean;
  restarting: boolean;
  addProject(root: string): Promise<void>;
  removeProject(root: string): Promise<void>;
  reindexProject(root: string): Promise<void>;
  reindexMany(roots: string[]): Promise<void>;
  removeMany(roots: string[]): Promise<void>;
  refresh(): Promise<void>;
  restartDaemon(): Promise<void>;
}

interface MetricsSetters {
  setMetrics: (m: ProjectHealthMetrics[]) => void;
  setError: (e: string | null) => void;
}

/** Fetch the dashboard cache once. Exported so tests can drive it directly. */
export async function fetchMetricsOnce(setters: MetricsSetters): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/dashboard/projects`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setters.setError(body.error ?? `HTTP ${res.status}`);
      return;
    }
    const data = (await res.json()) as { projects: ProjectHealthMetrics[] };
    setters.setMetrics(data.projects ?? []);
    setters.setError(null);
  } catch (err) {
    setters.setError((err as Error)?.message ?? 'Failed to load dashboard metrics');
  }
}

export function useWorkspaceProjects(): UseWorkspaceProjectsResult {
  const daemon = useDaemon();

  const [metrics, setMetrics] = useState<ProjectHealthMetrics[]>([]);
  const [metricsLoaded, setMetricsLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Single-flight metrics fetch + loaded-flag bookkeeping.
  const fetchMetrics = useCallback(async () => {
    await fetchMetricsOnce({ setMetrics, setError });
    setMetricsLoaded(true);
  }, []);

  // Initial fetch + 5-min polling fallback.
  const resetTimer = useCallback(() => {
    if (intervalRef.current != null) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => void fetchMetrics(), AUTO_REFRESH_INTERVAL_MS);
  }, [fetchMetrics]);

  useEffect(() => {
    void fetchMetrics();
    resetTimer();
    return () => {
      if (intervalRef.current != null) clearInterval(intervalRef.current);
      if (debounceRef.current != null) clearTimeout(debounceRef.current);
    };
  }, [fetchMetrics, resetTimer]);

  // Reactive invalidation: when any daemon project completes a pipeline,
  // schedule a debounced metrics refetch.
  useEffect(() => {
    const shouldRefetch = detectCompletionInDiff(prevStatusRef.current, daemon.projects);
    // Update the snapshot regardless of refetch decision so the next diff
    // is computed against the latest observed statuses.
    prevStatusRef.current = new Map(daemon.projects.map((p) => [p.root, p.status]));
    if (!shouldRefetch) return;
    if (debounceRef.current != null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchMetrics();
    }, STATUS_TRANSITION_DEBOUNCE_MS);
  }, [daemon.projects, fetchMetrics]);

  // Manual refresh — invalidate server cache, refetch, reset timer.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch(`${BASE}/api/dashboard/refresh`, { method: 'POST' });
    } catch {
      // Best-effort; still fetch even if invalidation failed.
    }
    await fetchMetrics();
    resetTimer();
    setRefreshing(false);
  }, [fetchMetrics, resetTimer]);

  // Bulk mutations — Promise.allSettled, surface first failure.
  const reindexMany = useCallback(
    async (roots: string[]) => {
      const results = await Promise.allSettled(roots.map((r) => daemon.reindexProject(r)));
      const failed = results.find((r) => r.status === 'rejected');
      if (failed && failed.status === 'rejected') {
        setError(String(failed.reason ?? 'Reindex failed for at least one project'));
      }
    },
    [daemon.reindexProject],
  );

  const removeMany = useCallback(
    async (roots: string[]) => {
      const results = await Promise.allSettled(roots.map((r) => daemon.removeProject(r)));
      const failed = results.find((r) => r.status === 'rejected');
      if (failed && failed.status === 'rejected') {
        setError(String(failed.reason ?? 'Remove failed for at least one project'));
      }
    },
    [daemon.removeProject],
  );

  const projects = useMemo(
    () => mergeIntoViewModel(daemon.projects, metrics),
    [daemon.projects, metrics],
  );

  // We're loading when neither source has produced anything yet.
  const loading = daemon.loading && !metricsLoaded && projects.length === 0;

  return {
    projects,
    loading,
    refreshing,
    error,
    connected: daemon.connected,
    restarting: daemon.restarting,
    addProject: daemon.addProject,
    removeProject: daemon.removeProject,
    reindexProject: daemon.reindexProject,
    reindexMany,
    removeMany,
    refresh,
    restartDaemon: daemon.restartDaemon,
  };
}
