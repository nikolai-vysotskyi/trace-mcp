/**
 * Periodic vitals breadcrumb for the long-lived daemon (TRA-267).
 *
 * Why this exists: `process-safety-net.ts` catches errors that reach a JS
 * handler, but an OS-level kill (macOS Jetsam / OOM killer, SIGKILL) or a
 * native crash in better-sqlite3 / onnxruntime runs no JS at all. The process
 * just disappears and daemon.log's last line is an ordinary indexing message —
 * which is exactly what was observed when the daemon exited twice under a
 * 45-project registry. Nothing in the log said whether memory was the cause.
 *
 * A periodic memory line turns that silence into evidence: the trajectory in
 * the minutes before the gap says whether RSS was climbing, and how many
 * projects were loaded/indexing at the time.
 */
import { logger } from '../logger.js';

export interface DaemonVitals {
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  uptime_s: number;
  projects_loaded: number;
  projects_indexing: number;
}

export interface ProjectCounts {
  loaded: number;
  indexing: number;
}

const toMb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

/** Snapshot process memory + project counts. Pure apart from two cheap syscalls. */
export function buildVitals(counts: ProjectCounts): DaemonVitals {
  const mem = process.memoryUsage();
  return {
    rss_mb: toMb(mem.rss),
    heap_used_mb: toMb(mem.heapUsed),
    heap_total_mb: toMb(mem.heapTotal),
    external_mb: toMb(mem.external),
    uptime_s: Math.round(process.uptime()),
    projects_loaded: counts.loaded,
    projects_indexing: counts.indexing,
  };
}

/**
 * Log one vitals line now, then every `intervalMs` (default 60s). The timer is
 * unref'd so it never keeps the process alive on its own. Returns a stop
 * function.
 */
export function startVitalsLog(opts: {
  getCounts: () => ProjectCounts;
  intervalMs?: number;
}): () => void {
  const emit = (): void => {
    try {
      logger.info(buildVitals(opts.getCounts()), 'Daemon vitals');
    } catch (err) {
      // A vitals line must never be the thing that kills the daemon.
      logger.warn({ err: String(err) }, 'Daemon vitals snapshot failed (non-fatal)');
    }
  };
  emit();
  const timer = setInterval(emit, opts.intervalMs ?? 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
