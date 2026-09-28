/**
 * Symptom-driven memory diagnostics for the daemon.
 *
 * Exposes `buildMemoryReport(deps)` — a pure function that snapshots
 * `process.memoryUsage()` + sizes of every known in-memory cache that
 * lives inside the daemon HTTP server bootstrap. Surfaced through the
 * `GET /debug/memory` route; can also be driven from a unit test by
 * passing stub maps in `deps`.
 *
 * Keep the response shape stable — clients (operators, ad-hoc memory
 * dashboards) depend on it. Add new fields, don't rename existing ones.
 */
import { getHeapStatistics } from 'node:v8';
import { __projectStatsCacheStats } from '../api/project-stats-routes.js';
import { __recentReindexCacheStats } from '../indexer/recent-reindex-cache.js';
import { getGlobalTelemetrySink } from '../telemetry/index.js';
import type { TelemetrySink } from '../telemetry/types.js';

/** Cap for the per-session journal pressure list — bounds the response. */
export const SESSION_JOURNAL_TOP_N = 10;

export interface SessionJournalPressure {
  sessionId: string;
  entries: number;
  compactBytes: number;
}

export interface LoadedProjectInfo {
  root: string;
  status: string;
}

export interface MemoryReportDeps {
  /** sessionId/clientId → TrackedClient map. Daemon-local. */
  clients: { size: number };
  /** Active SSE responses set. Daemon-local. */
  sseConnections: { size: number };
  /** Per-IP rate-limit bucket map. Daemon-local. */
  rateBuckets: { size: number };
  /** Progress-event throttle map (event-key → last-emit-ms). Daemon-local. */
  lastProgressEmittedAt: { size: number };
  /** Per-project progress unsubscribe handles. Daemon-local. */
  progressUnsubscribers: { size: number };
  /** projectRoot → Set<sessionId>. Daemon-local. */
  projectSessions: { size: number };
  /** sessionId → MCP transport. Daemon-local. */
  sessionTransports: { size: number };
  /** sessionId → ServerHandle. Daemon-local. */
  sessionHandles: { size: number };
  /** sessionId → clientId. Daemon-local. */
  sessionClients: { size: number };
  /** sessionId → last-traffic epoch ms (stale-session sweep clock). Daemon-local. */
  sessionLastSeen: { size: number };
  /** Registered project count (projectManager.listProjects().length). */
  registeredProjects: number;
  /** Distinct roots currently tracked by the resource pool (TRA-2017). */
  resourcePoolEntries: number;
  /** Sum of SessionJournal entries across live sessions (TRA-2017). */
  sessionJournalEntries: number;
  /** Sum of retained compact-snapshot bytes across live journals (TRA-2017). */
  sessionJournalCompactBytes: number;
  /**
   * Per-session journal pressure (TRA-2061). The aggregates above can't tell
   * "ten quiet sessions" from "one runaway session" — this list can. The
   * builder sorts by compactBytes desc and keeps the top SESSION_JOURNAL_TOP_N.
   */
  sessionJournals: SessionJournalPressure[];
  /** Currently resident projects (root + status) — TRA-2061. */
  loadedProjects: LoadedProjectInfo[];
  /** Daemon-lifetime descendant-wake bookkeeping size (ProjectManager). */
  descendantWakeEntries: number;
  /** Stalled-indexing warn-latch size (ProjectManager). */
  stallWarnedRoots: number;
  /** Main-thread tree-sitter cache footprint (TRA-1577, bounded 200 entries / 64MB). */
  treeCacheEntries: number;
  treeCacheApproxBytes: number;
}

export interface MemoryReportProcess {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

/**
 * V8 heap statistics (TRA-2061). The triage number is `used_ratio`:
 * approaching 1.0 means the process is on a V8-OOM trajectory (JS leak);
 * a huge RSS with a low ratio means native/mmap (SQLite, tree-sitter),
 * not the JS heap.
 */
export interface MemoryReportHeap {
  used: number;
  total: number;
  limit: number;
  malloced: number;
  peakMalloced: number;
  usedRatio: number;
}

export interface MemoryReportCaches {
  clients: number;
  sseConnections: number;
  rateBuckets: number;
  lastProgressEmittedAt: number;
  progressUnsubscribers: number;
  projectSessions: number;
  sessionTransports: number;
  sessionHandles: number;
  sessionClients: number;
  sessionLastSeen: number;
  registered_projects: number;
  recent_reindex_total_entries: number;
  recent_reindex_projects: number;
  project_stats_cache_entries: number;
  tree_cache_entries: number;
  tree_cache_approx_bytes: number;
  descendant_wake_entries: number;
  stall_warned_roots: number;
  resource_pool_entries: number;
  session_journal_total_entries: number;
  session_journal_compact_bytes: number;
}

export interface MemoryReportTelemetry {
  otlp_buffer?: number;
  langfuse_buffer?: number;
}

export interface MemoryReport {
  process: MemoryReportProcess;
  /** V8 heap statistics — added TRA-2061, see MemoryReportHeap. */
  heap: MemoryReportHeap;
  uptime_seconds: number;
  caches: MemoryReportCaches;
  /**
   * Per-session journal pressure, top SESSION_JOURNAL_TOP_N by compact bytes
   * desc — added TRA-2061. Answers "which session holds the heap" when the
   * totals above are high.
   */
  sessions_top: SessionJournalPressure[];
  /** Currently resident projects — added TRA-2061. */
  loaded_projects: LoadedProjectInfo[];
  telemetry?: MemoryReportTelemetry;
}

interface BufferedSink extends TelemetrySink {
  getBufferSize(): number;
}

function hasGetBufferSize(sink: TelemetrySink): sink is BufferedSink {
  return typeof (sink as { getBufferSize?: unknown }).getBufferSize === 'function';
}

/**
 * Probe the global telemetry sink for OTLP/Langfuse buffer sizes. Returns
 * `undefined` when the sink is Noop (or anything else that doesn't expose
 * a `getBufferSize()` method) — caller should omit the `telemetry` field
 * entirely in that case.
 */
function collectTelemetryBuffers(): MemoryReportTelemetry | undefined {
  const sink = getGlobalTelemetrySink();
  if (!hasGetBufferSize(sink)) return undefined;
  const out: MemoryReportTelemetry = {};
  if (sink.name === 'otlp') {
    out.otlp_buffer = sink.getBufferSize();
  } else if (sink.name === 'langfuse') {
    out.langfuse_buffer = sink.getBufferSize();
  } else {
    // Unknown buffered sink — surface under whichever bucket fits. Default to
    // otlp since that's the historical shape.
    out.otlp_buffer = sink.getBufferSize();
  }
  return out;
}

/**
 * Build the `/debug/memory` payload. Pure — no I/O beyond the cheap
 * `process.memoryUsage()`, `process.uptime()` and `v8.getHeapStatistics()`
 * syscalls (plus the module-state cache stats readers).
 */
export function buildMemoryReport(deps: MemoryReportDeps): MemoryReport {
  const mem = process.memoryUsage();
  const heapStats = getHeapStatistics();
  const recent = __recentReindexCacheStats();
  const stats = __projectStatsCacheStats();
  const sessionsTop = [...deps.sessionJournals]
    .sort((a, b) => b.compactBytes - a.compactBytes || b.entries - a.entries)
    .slice(0, SESSION_JOURNAL_TOP_N);
  const report: MemoryReport = {
    process: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    heap: {
      used: heapStats.used_heap_size,
      total: heapStats.total_heap_size,
      limit: heapStats.heap_size_limit,
      malloced: heapStats.malloced_memory,
      peakMalloced: heapStats.peak_malloced_memory,
      usedRatio:
        heapStats.heap_size_limit > 0
          ? Math.round((heapStats.used_heap_size / heapStats.heap_size_limit) * 1000) / 1000
          : 0,
    },
    uptime_seconds: process.uptime(),
    caches: {
      clients: deps.clients.size,
      sseConnections: deps.sseConnections.size,
      rateBuckets: deps.rateBuckets.size,
      lastProgressEmittedAt: deps.lastProgressEmittedAt.size,
      progressUnsubscribers: deps.progressUnsubscribers.size,
      projectSessions: deps.projectSessions.size,
      sessionTransports: deps.sessionTransports.size,
      sessionHandles: deps.sessionHandles.size,
      sessionClients: deps.sessionClients.size,
      sessionLastSeen: deps.sessionLastSeen.size,
      registered_projects: deps.registeredProjects,
      recent_reindex_total_entries: recent.totalEntries,
      recent_reindex_projects: recent.projects,
      project_stats_cache_entries: stats.size,
      tree_cache_entries: deps.treeCacheEntries,
      tree_cache_approx_bytes: deps.treeCacheApproxBytes,
      descendant_wake_entries: deps.descendantWakeEntries,
      stall_warned_roots: deps.stallWarnedRoots,
      resource_pool_entries: deps.resourcePoolEntries,
      session_journal_total_entries: deps.sessionJournalEntries,
      session_journal_compact_bytes: deps.sessionJournalCompactBytes,
    },
    sessions_top: sessionsTop,
    loaded_projects: [...deps.loadedProjects],
  };
  const telemetry = collectTelemetryBuffers();
  if (telemetry) report.telemetry = telemetry;
  return report;
}
