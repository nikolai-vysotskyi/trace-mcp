/**
 * Journal stats API route — aggregated metrics for the Activity tab v2.
 *
 * Endpoint: GET /api/projects/journal/stats?project=<root>&window=<ms>
 *
 * The handler is pure aggregation: it receives journal entries via the
 * JournalStatsContext interface (wired by cli.ts) and computes statistics
 * over the requested time window.
 *
 * Wire-up in cli.ts (right after the GET /api/projects/journal block):
 *
 *   const journalStatsCtx: JournalStatsContext = {
 *     listEntriesForProject(projectRoot) {
 *       const sids = projectSessions.get(projectRoot);
 *       if (!sids || sids.size === 0) return [];
 *       const entries: JournalEntryEvent[] = [];
 *       for (const sid of sids) {
 *         const handle = sessionHandles.get(sid);
 *         if (handle) {
 *           entries.push(...buildJournalSnapshot(handle.journal, projectRoot, sid, 10000));
 *         }
 *       }
 *       return entries;
 *     },
 *   };
 *   if (handleJournalStatsRequest(req, res, url, journalStatsCtx)) return;
 */

import http from 'node:http';

// ---------------------------------------------------------------------------
// Context interface — wired by cli.ts, keeps this module dependency-free
// ---------------------------------------------------------------------------

/**
 * A single journal entry as seen by the stats handler.
 * Matches the shape of JournalEntryEvent from journal-broadcast.ts.
 */
export interface JournalEntryForStats {
  ts: number;
  tool: string;
  params_summary: string;
  result_count: number;
  result_tokens?: number;
  latency_ms?: number;
  is_error: boolean;
  session_id: string;
}

/**
 * Context object the integrator must provide.
 * Returns all known entries for a project across all active sessions,
 * newest-first or any order (the handler sorts by ts internally).
 */
export interface JournalStatsContext {
  listEntriesForProject(projectRoot: string): JournalEntryForStats[];
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface HotTool {
  tool: string;
  count: number;
  avg_latency_ms: number;
  error_count: number;
}

export interface HotFile {
  file: string;
  count: number;
}

export interface LatencyBucket {
  bucket_ms: number; // left edge; Infinity represented as -1
  count: number;
}

export interface ErrorGroup {
  tool: string;
  sample_summary: string;
  count: number;
}

export interface ByMinute {
  ts: number; // minute-floor Unix ms
  count: number;
  error_count: number;
}

export interface JournalStatsResponse {
  window_ms: number;
  total_calls: number;
  error_rate: number;
  hot_tools: HotTool[];
  hot_files: HotFile[];
  latency_buckets: LatencyBucket[];
  error_groups: ErrorGroup[];
  by_minute: ByMinute[];
}

// ---------------------------------------------------------------------------
// Latency bucket boundaries (left-inclusive, right-exclusive)
// Last bucket is open-ended (>=5000ms), represented as bucket_ms=-1 in output.
// ---------------------------------------------------------------------------

const BUCKET_EDGES = [0, 10, 50, 100, 500, 1000, 5000] as const;

function assignBucket(latency_ms: number): number {
  for (let i = BUCKET_EDGES.length - 1; i >= 0; i--) {
    if (latency_ms >= BUCKET_EDGES[i]) return BUCKET_EDGES[i];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Hot-file extraction heuristic
//
// Extracts file-like tokens from params_summary. Patterns detected (lenient):
//   path=src/foo.ts          key=value with file extension
//   file=packages/bar.tsx    literal "file=" prefix
//   "src/foo.ts"             quoted paths
//   src/foo.ts               bare relative paths in the summary
//   *.ts / *.py              glob-style extensions
//
// We extract tokens that look like file paths: contain a slash or dot, and
// end with a known source extension.
// ---------------------------------------------------------------------------

const FILE_EXTS_RE =
  /\b([\w.\-/@]+\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|rb|php|cs|cpp|c|h|hpp|swift|vue|svelte|astro))\b/g;

function extractFilesFromSummary(summary: string): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  FILE_EXTS_RE.lastIndex = 0;
  while ((m = FILE_EXTS_RE.exec(summary)) !== null) {
    const token = m[1];
    // Require at least one slash or a path separator to filter out bare names
    // like "foo.ts" with no directory component — keep if it looks like a path.
    if (token.includes('/') || token.startsWith('.')) {
      matches.push(token);
    } else {
      // Bare filename — include anyway as best-effort (params often have just filename)
      matches.push(token);
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

function aggregate(entries: JournalEntryForStats[], windowMs: number): JournalStatsResponse {
  const cutoff = Date.now() - windowMs;
  const windowed = entries.filter((e) => e.ts >= cutoff);

  const totalCalls = windowed.length;
  const errorCount = windowed.filter((e) => e.is_error).length;
  const errorRate = totalCalls > 0 ? errorCount / totalCalls : 0;

  // ── Hot tools ──────────────────────────────────────────────────────────
  const toolStats = new Map<
    string,
    { count: number; latencySum: number; latencyCount: number; errors: number }
  >();
  for (const e of windowed) {
    const s = toolStats.get(e.tool) ?? { count: 0, latencySum: 0, latencyCount: 0, errors: 0 };
    s.count++;
    if (e.latency_ms !== undefined && e.latency_ms >= 0) {
      s.latencySum += e.latency_ms;
      s.latencyCount++;
    }
    if (e.is_error) s.errors++;
    toolStats.set(e.tool, s);
  }
  const hotTools: HotTool[] = [...toolStats.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([tool, s]) => ({
      tool,
      count: s.count,
      avg_latency_ms: s.latencyCount > 0 ? Math.round(s.latencySum / s.latencyCount) : 0,
      error_count: s.errors,
    }));

  // ── Hot files ──────────────────────────────────────────────────────────
  const fileCounts = new Map<string, number>();
  for (const e of windowed) {
    const files = extractFilesFromSummary(e.params_summary);
    for (const f of files) {
      fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    }
  }
  const hotFiles: HotFile[] = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }));

  // ── Latency histogram ──────────────────────────────────────────────────
  const bucketCounts = new Map<number, number>();
  // Initialise all defined buckets to zero
  for (const edge of BUCKET_EDGES) bucketCounts.set(edge, 0);
  const INF_KEY = -1; // open-ended >=5000ms bucket
  bucketCounts.set(INF_KEY, 0);

  for (const e of windowed) {
    if (e.latency_ms === undefined || e.latency_ms < 0) continue;
    if (e.latency_ms >= 5000) {
      bucketCounts.set(INF_KEY, (bucketCounts.get(INF_KEY) ?? 0) + 1);
    } else {
      const b = assignBucket(e.latency_ms);
      bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1);
    }
  }

  const latencyBuckets: LatencyBucket[] = [
    ...BUCKET_EDGES.map((edge) => ({ bucket_ms: edge, count: bucketCounts.get(edge) ?? 0 })),
    { bucket_ms: INF_KEY, count: bucketCounts.get(INF_KEY) ?? 0 },
  ];

  // ── Error groups ────────────────────────────────────────────────────────
  const errorGroups = new Map<string, { sample: string; count: number }>();
  for (const e of windowed) {
    if (!e.is_error) continue;
    const existing = errorGroups.get(e.tool);
    if (!existing) {
      errorGroups.set(e.tool, { sample: e.params_summary, count: 1 });
    } else {
      existing.count++;
    }
  }
  const errorGroupsList: ErrorGroup[] = [...errorGroups.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([tool, g]) => ({
      tool,
      sample_summary: g.sample,
      count: g.count,
    }));

  // ── By-minute sparkline (last 60 minutes) ─────────────────────────────
  const MINUTE_MS = 60_000;
  const nowFloor = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  const minuteMap = new Map<number, { count: number; error_count: number }>();
  // Pre-fill last 60 minutes
  for (let i = 59; i >= 0; i--) {
    minuteMap.set(nowFloor - i * MINUTE_MS, { count: 0, error_count: 0 });
  }
  for (const e of windowed) {
    const minuteTs = Math.floor(e.ts / MINUTE_MS) * MINUTE_MS;
    const bucket = minuteMap.get(minuteTs);
    if (bucket) {
      bucket.count++;
      if (e.is_error) bucket.error_count++;
    }
  }
  const byMinute: ByMinute[] = [...minuteMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, v]) => ({ ts, count: v.count, error_count: v.error_count }));

  return {
    window_ms: windowMs,
    total_calls: totalCalls,
    error_rate: errorRate,
    hot_tools: hotTools,
    hot_files: hotFiles,
    latency_buckets: latencyBuckets,
    error_groups: errorGroupsList,
    by_minute: byMinute,
  };
}

// ---------------------------------------------------------------------------
// Route handler — returns true if it handled the request, false otherwise
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 3_600_000; // 1 hour
const MAX_WINDOW_MS = 86_400_000; // 24 hours cap

export function handleJournalStatsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: JournalStatsContext,
): boolean {
  if (req.method !== 'GET' || url.pathname !== '/api/projects/journal/stats') {
    return false;
  }

  const projectRoot = url.searchParams.get('project');
  if (!projectRoot) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'project query param is required' }));
    return true;
  }

  const rawWindow = url.searchParams.get('window');
  const windowMs = rawWindow
    ? Math.min(MAX_WINDOW_MS, Math.max(1, parseInt(rawWindow, 10) || DEFAULT_WINDOW_MS))
    : DEFAULT_WINDOW_MS;

  const entries = ctx.listEntriesForProject(projectRoot);
  const stats = aggregate(entries, windowMs);

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(stats));
  return true;
}
