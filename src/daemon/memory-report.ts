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
import { __projectStatsCacheStats } from '../api/project-stats-routes.js';
import { __recentReindexCacheStats } from '../indexer/recent-reindex-cache.js';
import { getGlobalTelemetrySink } from '../telemetry/index.js';
import type { TelemetrySink } from '../telemetry/types.js';

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
  /** Registered project count (projectManager.listProjects().length). */
  registeredProjects: number;
}

export interface MemoryReportProcess {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
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
  registered_projects: number;
  recent_reindex_total_entries: number;
  project_stats_cache_entries: number;
}

export interface MemoryReportTelemetry {
  otlp_buffer?: number;
  langfuse_buffer?: number;
}

export interface MemoryReport {
  process: MemoryReportProcess;
  uptime_seconds: number;
  caches: MemoryReportCaches;
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
 * `process.memoryUsage()` and `process.uptime()` syscalls.
 */
export function buildMemoryReport(deps: MemoryReportDeps): MemoryReport {
  const mem = process.memoryUsage();
  const recent = __recentReindexCacheStats();
  const stats = __projectStatsCacheStats();
  const report: MemoryReport = {
    process: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
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
      registered_projects: deps.registeredProjects,
      recent_reindex_total_entries: recent.totalEntries,
      project_stats_cache_entries: stats.size,
    },
  };
  const telemetry = collectTelemetryBuffers();
  if (telemetry) report.telemetry = telemetry;
  return report;
}
