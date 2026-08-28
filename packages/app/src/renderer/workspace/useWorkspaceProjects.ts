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
import { DAEMON_FETCH_TIMEOUT_MS, useDaemon } from '../hooks/useDaemon';
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
  /**
   * True until the first `/api/dashboard/projects` response lands. The project
   * list arrives seconds earlier, so `loading` is already false while every
   * metric is still zero — consumers must not render metric numbers yet.
   */
  metricsLoading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Why `error` happened — drives the wording and the offered action. */
  errorKind: MetricsErrorKind | null;
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

/**
 * Why metrics are missing. "Not reachable" is the wrong diagnosis for a daemon
 * that is alive but spending eight seconds indexing eighty projects, and the
 * copy the user reads has to say which of the two happened.
 */
export type MetricsErrorKind = 'timeout' | 'offline' | 'server';

interface MetricsSetters {
  setMetrics: (m: ProjectHealthMetrics[]) => void;
  setError: (e: string | null) => void;
  setErrorKind?: (k: MetricsErrorKind | null) => void;
}

/** Classify a fetch rejection. A timeout means slow, not gone. */
export function classifyMetricsError(err: unknown): MetricsErrorKind {
  const e = err as { name?: string; message?: string } | null;
  const raw = `${e?.name ?? ''} ${e?.message ?? ''}`;
  if (/timeout|timed? ?out|abort/i.test(raw)) return 'timeout';
  if (/failed to fetch|networkerror|load failed|refused/i.test(raw)) return 'offline';
  return 'server';
}

/**
 * Turn a raw fetch rejection into something a user can act on. `Failed to
 * fetch` / `The operation was aborted` are the browser's own words for "the
 * socket died" and mean nothing to the person reading the banner.
 */
export function describeMetricsError(err: unknown): string {
  switch (classifyMetricsError(err)) {
    case 'timeout':
      return 'The daemon is taking too long to answer — it may still be indexing.';
    case 'offline':
      return "Couldn't load project metrics — daemon not responding.";
    default: {
      const raw = (err as Error)?.message ?? '';
      return raw ? `Couldn't load project metrics — ${raw}` : "Couldn't load project metrics.";
    }
  }
}

/**
 * Fetch the dashboard cache once. Exported so tests can drive it directly.
 * Returns true only when metrics actually landed — the caller uses that to
 * decide whether the KPI strip may stop rendering `—` placeholders.
 */
export async function fetchMetricsOnce(setters: MetricsSetters): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/dashboard/projects`, { signal: AbortSignal.timeout(DAEMON_FETCH_TIMEOUT_MS) }); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setters.setError(`Couldn't load project metrics — ${body.error ?? `HTTP ${res.status}`}`);
      setters.setErrorKind?.('server');
      return false;
    }
    const data = (await res.json()) as { projects: ProjectHealthMetrics[] };
    setters.setMetrics(data.projects ?? []);
    setters.setError(null);
    setters.setErrorKind?.(null);
    return true;
  } catch (err) {
    setters.setError(describeMetricsError(err));
    setters.setErrorKind?.(classifyMetricsError(err));
    return false;
  }
}

export function useWorkspaceProjects(): UseWorkspaceProjectsResult {
  const daemon = useDaemon();

  const [metrics, setMetrics] = useState<ProjectHealthMetrics[]>([]);
  const [metricsLoaded, setMetricsLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<MetricsErrorKind | null>(null);

  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Single-flight metrics fetch. Only a *successful* fetch clears the loading
  // flag — otherwise the KPI strip would swap `—` placeholders for hard zeros
  // and present a failed fetch as real data (TRA-264).
  const fetchMetrics = useCallback(async () => {
    const ok = await fetchMetricsOnce({ setMetrics, setError, setErrorKind });
    if (ok) setMetricsLoaded(true);
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
      await fetch(`${BASE}/api/dashboard/refresh`, { method: 'POST', signal: AbortSignal.timeout(DAEMON_FETCH_TIMEOUT_MS) }); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
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
    metricsLoading: !metricsLoaded,
    refreshing,
    error,
    errorKind,
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
