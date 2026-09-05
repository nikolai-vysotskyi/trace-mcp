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
 *
 * Degraded behaviour (TRA-397): the last successful metrics response is kept
 * in localStorage, so a launch against a daemon that is busy indexing opens on
 * the last known numbers instead of on em dashes. A slow daemon and a
 * disconnected feed collapse into one {@link DaemonState}: the app is showing a
 * snapshot, and it says so once rather than escalating through three sentences.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BASE, DAEMON_FETCH_TIMEOUT_MS, daemonFetch } from '../daemon-fetch';
import { loadSnapshot, saveSnapshot } from '../snapshot';
import { useDaemon } from '../hooks/useDaemon';
import { t } from '../i18n';
import {
  type ProjectHealthMetrics,
  type ProjectViewModel,
  mergeIntoViewModel,
} from './types';

export const AUTO_REFRESH_INTERVAL_MS = 300_000; // 5 min — matches backend cache TTL.
export const STATUS_TRANSITION_DEBOUNCE_MS = 1000;

/**
 * How long a degraded reading has to hold before the banner appears. The event
 * feed drops and re-opens in well under a second while the daemon is loaded,
 * and a banner that blinks in and out of a screen reads as broken rather than
 * busy. Recovery is published immediately — only degradation waits.
 */
export const DEGRADED_GRACE_MS = 1500;

/** Last successful `/api/dashboard/projects` response, kept across launches. */
const LS_METRICS_KEY = 'trace-mcp.workspace.metrics';

export function loadMetricsSnapshot(): ProjectHealthMetrics[] {
  const parsed = loadSnapshot<unknown>(LS_METRICS_KEY);
  return Array.isArray(parsed) ? (parsed as ProjectHealthMetrics[]) : [];
}

export function saveMetricsSnapshot(metrics: ProjectHealthMetrics[]): void {
  saveSnapshot(LS_METRICS_KEY, metrics);
}

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
  /**
   * A mutation that failed and has something to say — a reindex or a remove.
   * A metrics fetch never lands here: "the numbers are a moment old" is a
   * state, not an error, and it is reported through {@link daemonState}.
   */
  error: string | null;
  /** Why the last metrics fetch failed, if it did. */
  errorKind: MetricsErrorKind | null;
  /** One reading of how much the daemon is answering. */
  daemonState: DaemonState;
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

/**
 * How much of the daemon is answering, as one value.
 *
 * The three failures a user could hit here — a metrics read that timed out, a
 * metrics read refused, an event feed that dropped — are one condition seen at
 * three thresholds, not three things to act on differently. Escalating through
 * a sentence each made a busy daemon look like a broken app (TRA-397), so they
 * collapse to `stale`: what is on screen is the last indexed snapshot, and it
 * stays on screen.
 *
 * `unreachable` is kept apart because it is genuinely different and genuinely
 * actionable — the daemon never answered at all, so there is a process to
 * start rather than a wait to sit through.
 */
export type DaemonState = 'ok' | 'stale' | 'unreachable';

/**
 * Pure state reduction — no timers, no React. `loading` wins: the first
 * moment of a launch is the skeleton's, and a daemon that has not answered
 * *yet* is not a daemon that is failing to.
 */
export function deriveDaemonState(o: {
  /** The daemon's own first read is still in flight. */
  loading: boolean;
  /** The event feed is open. */
  connected: boolean;
  /** Projects the daemon itself has named this session. */
  liveProjects: number;
  metricsErrorKind: MetricsErrorKind | null;
  /**
   * TRA-525: the daemon's OS process is provably alive (daemon.pid names a
   * live, ownership-verified process). `undefined` means "not known" — only a
   * definite `true` may override the no-feed reading.
   */
  processAlive?: boolean;
}): DaemonState {
  if (o.loading) return 'ok';
  if (!o.connected) {
    // TRA-525: "isn't running" has to mean the process is gone. Measured on
    // this machine, the daemon's event loop is starved by indexing to a
    // /health p50 of 7.8s — it stops answering while very much running, and
    // calling that "isn't running" sends the user to start something that is
    // already started. A live process with no feed is `stale`: there is
    // nothing to start, only a wait to sit through.
    if (o.processAlive === true) return 'stale';
    // No feed and nothing the daemon ever told us: it isn't running.
    return o.liveProjects > 0 ? 'stale' : 'unreachable';
  }
  return o.metricsErrorKind === null ? 'ok' : 'stale';
}

/**
 * Poll main-process daemon liveness while `active`. Returns `undefined` until
 * an answer lands (and outside the app shell, where the bridge is absent), so
 * the reducer keeps its old reading rather than guessing (TRA-525).
 */
export function useDaemonProcessAlive(active: boolean): boolean | undefined {
  const [alive, setAlive] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!active) {
      setAlive(undefined);
      return;
    }
    const probe = window.electronAPI?.daemonProcessAlive;
    if (!probe) return;
    let cancelled = false;
    const read = () => {
      probe()
        .then((v) => {
          if (!cancelled) setAlive(v);
        })
        .catch(() => {
          /* bridge unavailable — leave the reading alone */
        });
    };
    read();
    const t = setInterval(read, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [active]);
  return alive;
}

interface MetricsSetters {
  setMetrics: (m: ProjectHealthMetrics[]) => void;
  setErrorKind: (k: MetricsErrorKind | null) => void;
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
 * Fetch the dashboard cache once. Exported so tests can drive it directly.
 * Returns true only when metrics actually landed — the caller uses that to
 * decide whether the KPI strip may stop rendering `—` placeholders.
 *
 * A failure publishes a *kind*, never a sentence: the copy the user reads is
 * one line owned by the surface, not three lines assembled here from whichever
 * transport error arrived first.
 */
export async function fetchMetricsOnce(setters: MetricsSetters): Promise<boolean> {
  try {
    const res = await daemonFetch(`${BASE}/api/dashboard/projects`); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
    if (!res.ok) {
      setters.setErrorKind('server');
      return false;
    }
    const data = (await res.json()) as { projects: ProjectHealthMetrics[] };
    setters.setMetrics(data.projects ?? []);
    setters.setErrorKind(null);
    return true;
  } catch (err) {
    setters.setErrorKind(classifyMetricsError(err));
    return false;
  }
}

export function useWorkspaceProjects(): UseWorkspaceProjectsResult {
  const daemon = useDaemon();

  // Open on the last snapshot rather than on nothing: a launch against a
  // daemon that is mid-index used to spend its first eight seconds showing
  // em dashes for numbers that were sitting on disk the whole time.
  const [metrics, setMetrics] = useState<ProjectHealthMetrics[]>(loadMetricsSnapshot);
  const [metricsLoaded, setMetricsLoaded] = useState(() => metrics.length > 0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<MetricsErrorKind | null>(null);

  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Single-flight metrics fetch. Only a *successful* fetch clears the loading
  // flag — otherwise the KPI strip would swap `—` placeholders for hard zeros
  // and present a failed fetch as real data (TRA-264). A failure also leaves
  // `metrics` alone, so whatever is on screen stays on screen.
  const fetchMetrics = useCallback(async () => {
    const ok = await fetchMetricsOnce({
      setMetrics: (m) => {
        setMetrics(m);
        saveMetricsSnapshot(m);
      },
      setErrorKind,
    });
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
      await daemonFetch(`${BASE}/api/dashboard/refresh`, { method: 'POST' }); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
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
        setError(String(failed.reason ?? t('workspace:bulkReindexFailed')));
      }
    },
    [daemon.reindexProject],
  );

  const removeMany = useCallback(
    async (roots: string[]) => {
      const results = await Promise.allSettled(roots.map((r) => daemon.removeProject(r)));
      const failed = results.find((r) => r.status === 'rejected');
      if (failed && failed.status === 'rejected') {
        setError(String(failed.reason ?? t('workspace:bulkRemoveFailed')));
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

  // One reading, held steady. Degradation waits out DEGRADED_GRACE_MS so a
  // feed that blinks doesn't blink a banner with it; recovery is immediate,
  // because there is no reason to keep telling someone their data is old
  // once it isn't.
  // TRA-525: only asked for while the feed is down, and only then — a live
  // process is the one thing that distinguishes "busy" from "gone", and there
  // is nothing to distinguish while the feed is up.
  const processAlive = useDaemonProcessAlive(!daemon.connected && !daemon.loading);

  const observedState = deriveDaemonState({
    loading: daemon.loading,
    connected: daemon.connected,
    liveProjects: daemon.projects.length,
    metricsErrorKind: errorKind,
    processAlive,
  });
  const [daemonState, setDaemonState] = useState<DaemonState>('ok');
  useEffect(() => {
    if (observedState === 'ok') {
      setDaemonState('ok');
      return;
    }
    const t = setTimeout(() => setDaemonState(observedState), DEGRADED_GRACE_MS);
    return () => clearTimeout(t);
  }, [observedState]);

  return {
    projects,
    loading,
    metricsLoading: !metricsLoaded,
    refreshing,
    error,
    errorKind,
    daemonState,
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
