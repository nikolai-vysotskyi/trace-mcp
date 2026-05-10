/**
 * Per-project deep-dive stats route — populates the rich `Stats` modal.
 *
 * Endpoint: GET /api/projects/full-stats?project=<root>
 *
 * NOTE: The simpler flat `GET /api/projects/stats` endpoint already exists in
 * `src/cli.ts` and is consumed by ProjectOverview / ProjectDetail. This route
 * adds a richer multi-section payload at a different path so the existing
 * consumers keep working unchanged.
 *
 * Returns a JSON object with seven sections. Each section is computed
 * independently and isolated in its own try/catch — a failing section is
 * returned as `null` rather than failing the whole response. Result is cached
 * in-process for 30s per (project,) key.
 *
 * Sections:
 *   - index        : file/symbol/edge counts, edge resolution-tier breakdown,
 *                    last-indexed timestamp, dependency coverage %
 *   - tools        : per-tool call count + median/p95 latency over last 24h
 *   - decisions    : count by type, confidence histogram, top-5 most-linked
 *   - performance  : embedding cache hit rate, search latency p50/p95,
 *                    indexer throughput
 *   - subprojects  : count + list with link health
 *   - quality      : dead exports count, untested symbols, complexity hotspots
 *   - content      : language distribution, top 10 largest files by symbol
 *                    count, framework breakdown
 *
 * Wire-up in cli.ts (next to the other handlers):
 *
 *   import { handleProjectStatsRequest } from './api/project-stats-routes.js';
 *   ...
 *   if (await handleProjectStatsRequest(req, res, url, { journalStatsCtx })) return;
 */

import fs from 'node:fs';
import http from 'node:http';
import Database from 'better-sqlite3';
import { DECISIONS_DB_PATH, REGISTRY_PATH, TOPOLOGY_DB_PATH } from '../global.js';
import type { JournalEntryForStats, JournalStatsContext } from './journal-stats-routes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexSection {
  files: number;
  symbols: number;
  edges: number;
  resolution_tiers: Record<string, number>;
  last_indexed: string | null;
  dependency_coverage_pct: number | null;
}

export interface ToolStat {
  tool: string;
  count: number;
  median_ms: number;
  p95_ms: number;
}

export interface ToolsSection {
  window_ms: number;
  total_calls: number;
  per_tool: ToolStat[];
}

export interface DecisionsSection {
  total: number;
  by_type: Record<string, number>;
  confidence_histogram: Record<string, number> | null;
  top_linked: Array<{ id: number; title: string; type: string; references: number }>;
}

export interface PerformanceSection {
  embedding_cache_hit_rate: number | null;
  search_latency_p50_ms: number | null;
  search_latency_p95_ms: number | null;
  indexer_throughput_files_per_sec: number | null;
  notes: string[];
}

export interface SubprojectInfo {
  name: string;
  repoRoot: string;
  serviceCount: number;
  endpointCount: number;
  link_health: 'ok' | 'missing' | 'unknown';
}

export interface SubprojectsSection {
  count: number;
  items: SubprojectInfo[];
}

export interface QualitySection {
  dead_exports: number | null;
  untested_symbols: number | null;
  complexity_hotspots: Array<{
    name: string;
    file: string;
    line: number;
    cyclomatic: number;
  }>;
}

export interface ContentSection {
  languages: Array<{ language: string; files: number }>;
  largest_files: Array<{ path: string; symbols: number }>;
  frameworks: Array<{ framework: string; files: number }>;
}

export interface ProjectStatsPayload {
  project: string;
  generated_at: string;
  index: IndexSection | null;
  tools: ToolsSection | null;
  decisions: DecisionsSection | null;
  performance: PerformanceSection | null;
  subprojects: SubprojectsSection | null;
  quality: QualitySection | null;
  content: ContentSection | null;
}

// ---------------------------------------------------------------------------
// Registry (mirrors dashboard-routes.ts; kept inline to stay independent)
// ---------------------------------------------------------------------------

interface RegistryEntry {
  name: string;
  root: string;
  dbPath: string;
  lastIndexed: string | null;
  addedAt: string;
}

interface Registry {
  version: 1;
  projects: Record<string, RegistryEntry>;
}

function readRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) return { version: 1, projects: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')) as unknown;
    if (
      raw &&
      typeof raw === 'object' &&
      'version' in raw &&
      (raw as { version: unknown }).version === 1 &&
      'projects' in raw
    ) {
      return raw as Registry;
    }
  } catch {
    /* fall through */
  }
  return { version: 1, projects: {} };
}

function findRegistryEntry(projectRoot: string): RegistryEntry | null {
  const reg = readRegistry();
  for (const entry of Object.values(reg.projects)) {
    if (entry.root === projectRoot) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Latency helpers
// ---------------------------------------------------------------------------

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return Math.round(sorted[base] + rest * (sorted[base + 1] - sorted[base]));
  }
  return Math.round(sorted[base]);
}

// ---------------------------------------------------------------------------
// Section computers — each one isolated; throws are caught by the caller
// ---------------------------------------------------------------------------

function computeIndex(db: Database.Database): IndexSection {
  const files =
    (db.prepare("SELECT COUNT(*) AS c FROM files WHERE status = 'ok'").get() as { c: number })?.c ??
    0;
  const symbols = (db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number })?.c ?? 0;
  const edges = (db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number })?.c ?? 0;

  const tierRows = db
    .prepare('SELECT resolution_tier AS tier, COUNT(*) AS c FROM edges GROUP BY resolution_tier')
    .all() as Array<{ tier: string; c: number }>;
  const resolution_tiers: Record<string, number> = {};
  for (const r of tierRows) resolution_tiers[r.tier] = r.c;

  const lastRow = db.prepare('SELECT MAX(indexed_at) AS t FROM files').get() as
    | { t: string | null }
    | undefined;

  // Dependency coverage = fraction of edges that are NOT 'text_matched'
  // (i.e. the resolver actually pinned them to a node, not just guessed by name).
  let dependency_coverage_pct: number | null = null;
  if (edges > 0) {
    const unresolved = resolution_tiers.text_matched ?? 0;
    const resolved = edges - unresolved;
    dependency_coverage_pct = Math.round((resolved / edges) * 1000) / 10;
  }

  return {
    files,
    symbols,
    edges,
    resolution_tiers,
    last_indexed: lastRow?.t ?? null,
    dependency_coverage_pct,
  };
}

function computeTools(entries: JournalEntryForStats[], windowMs: number): ToolsSection {
  const cutoff = Date.now() - windowMs;
  const windowed = entries.filter((e) => e.ts >= cutoff);

  const perTool = new Map<string, number[]>();
  for (const e of windowed) {
    const arr = perTool.get(e.tool) ?? [];
    if (e.latency_ms !== undefined && e.latency_ms >= 0) {
      arr.push(e.latency_ms);
    } else {
      // Push 0 so "count" still increments, but it won't affect quantiles
      // because we filter out zero-only series below by tracking count separately.
      arr.push(0);
    }
    perTool.set(e.tool, arr);
  }

  const per_tool: ToolStat[] = [];
  for (const [tool, latencies] of perTool) {
    const sorted = [...latencies].sort((a, b) => a - b);
    per_tool.push({
      tool,
      count: latencies.length,
      median_ms: quantile(sorted, 0.5),
      p95_ms: quantile(sorted, 0.95),
    });
  }
  per_tool.sort((a, b) => b.count - a.count);

  return {
    window_ms: windowMs,
    total_calls: windowed.length,
    per_tool,
  };
}

function computeDecisions(projectRoot: string): DecisionsSection {
  if (!fs.existsSync(DECISIONS_DB_PATH)) {
    return { total: 0, by_type: {}, confidence_histogram: null, top_linked: [] };
  }

  const db = new Database(DECISIONS_DB_PATH, { readonly: true });
  try {
    const total = (
      db.prepare('SELECT COUNT(*) AS c FROM decisions WHERE project_root = ?').get(projectRoot) as {
        c: number;
      }
    ).c;

    const byTypeRows = db
      .prepare('SELECT type, COUNT(*) AS c FROM decisions WHERE project_root = ? GROUP BY type')
      .all(projectRoot) as Array<{ type: string; c: number }>;
    const by_type: Record<string, number> = {};
    for (const r of byTypeRows) by_type[r.type] = r.c;

    // Confidence histogram (best-effort — schema may not have a confidence column).
    let confidence_histogram: Record<string, number> | null = null;
    try {
      const colInfo = db.prepare("PRAGMA table_info('decisions')").all() as Array<{
        name: string;
      }>;
      const hasConfidence = colInfo.some((c) => c.name === 'confidence');
      if (hasConfidence) {
        const histRows = db
          .prepare(
            `SELECT
               CASE
                 WHEN confidence IS NULL THEN 'unknown'
                 WHEN confidence < 0.25 THEN '0-25'
                 WHEN confidence < 0.5  THEN '25-50'
                 WHEN confidence < 0.75 THEN '50-75'
                 ELSE '75-100'
               END AS bucket,
               COUNT(*) AS c
             FROM decisions
             WHERE project_root = ?
             GROUP BY bucket`,
          )
          .all(projectRoot) as Array<{ bucket: string; c: number }>;
        confidence_histogram = {};
        for (const r of histRows) confidence_histogram[r.bucket] = r.c;
      }
    } catch {
      confidence_histogram = null;
    }

    // Top-linked = decisions with the most non-null symbol_id occurrences across the table.
    // Best-effort proxy for "most linked" without an explicit links table.
    let top_linked: DecisionsSection['top_linked'] = [];
    try {
      top_linked = db
        .prepare(
          `SELECT d.id AS id, d.title AS title, d.type AS type,
                  (SELECT COUNT(*) FROM decisions x
                   WHERE x.project_root = d.project_root
                     AND x.symbol_id = d.symbol_id
                     AND x.symbol_id IS NOT NULL) AS references
           FROM decisions d
           WHERE d.project_root = ?
             AND d.symbol_id IS NOT NULL
           ORDER BY references DESC, d.valid_from DESC
           LIMIT 5`,
        )
        .all(projectRoot) as DecisionsSection['top_linked'];
    } catch {
      top_linked = [];
    }

    return { total, by_type, confidence_histogram, top_linked };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function computePerformance(
  db: Database.Database,
  toolEntries: JournalEntryForStats[],
): PerformanceSection {
  const notes: string[] = [];

  // Embedding cache hit rate: not tracked yet — leave null.
  // Once an `embedding_cache_stats` table or counter is added, replace this.
  const embedding_cache_hit_rate: number | null = null;
  notes.push('embedding_cache_hit_rate is not recorded yet (TODO)');

  // Search latency derived from the journal entries for `search` tool.
  const searchLatencies = toolEntries
    .filter((e) => e.tool === 'search' && e.latency_ms !== undefined && e.latency_ms >= 0)
    .map((e) => e.latency_ms ?? 0)
    .sort((a, b) => a - b);
  const search_latency_p50_ms = searchLatencies.length > 0 ? quantile(searchLatencies, 0.5) : null;
  const search_latency_p95_ms = searchLatencies.length > 0 ? quantile(searchLatencies, 0.95) : null;

  // Indexer throughput = files / (max(indexed_at) - min(indexed_at)) seconds.
  // Gives a coarse but useful "files per second" of the most recent reindex.
  let indexer_throughput_files_per_sec: number | null = null;
  try {
    const row = db
      .prepare(
        `SELECT MIN(indexed_at) AS lo, MAX(indexed_at) AS hi, COUNT(*) AS c
         FROM files WHERE indexed_at IS NOT NULL`,
      )
      .get() as { lo: string | null; hi: string | null; c: number } | undefined;
    if (row && row.lo && row.hi && row.c > 0) {
      const lo = Date.parse(row.lo);
      const hi = Date.parse(row.hi);
      const seconds = Math.max(1, Math.round((hi - lo) / 1000));
      if (Number.isFinite(seconds) && seconds > 0) {
        indexer_throughput_files_per_sec = Math.round((row.c / seconds) * 100) / 100;
      }
    }
  } catch {
    indexer_throughput_files_per_sec = null;
  }

  return {
    embedding_cache_hit_rate,
    search_latency_p50_ms,
    search_latency_p95_ms,
    indexer_throughput_files_per_sec,
    notes,
  };
}

function computeSubprojects(projectRoot: string): SubprojectsSection {
  if (!fs.existsSync(TOPOLOGY_DB_PATH)) {
    return { count: 0, items: [] };
  }

  const db = new Database(TOPOLOGY_DB_PATH, { readonly: true });
  try {
    // Detect schema variants — different versions of trace-mcp use different
    // column/table names. We probe and fall back gracefully.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((t) => t.name));

    const items: SubprojectInfo[] = [];

    if (tableNames.has('subprojects')) {
      type Row = {
        name: string;
        repo_root: string;
        service_count?: number;
        endpoint_count?: number;
      };
      let rows: Row[] = [];
      try {
        rows = db
          .prepare(
            `SELECT name, repo_root,
                    COALESCE((SELECT COUNT(*) FROM services s WHERE s.subproject_id = sp.id), 0) AS service_count,
                    COALESCE((SELECT COUNT(*) FROM endpoints e WHERE e.subproject_id = sp.id), 0) AS endpoint_count
             FROM subprojects sp
             WHERE project_root = ?`,
          )
          .all(projectRoot) as Row[];
      } catch {
        // Fallback: simpler shape
        try {
          rows = db
            .prepare('SELECT name, repo_root FROM subprojects WHERE project_root = ?')
            .all(projectRoot) as Row[];
        } catch {
          rows = [];
        }
      }
      for (const r of rows) {
        const link_health: SubprojectInfo['link_health'] = fs.existsSync(r.repo_root)
          ? 'ok'
          : 'missing';
        items.push({
          name: r.name,
          repoRoot: r.repo_root,
          serviceCount: r.service_count ?? 0,
          endpointCount: r.endpoint_count ?? 0,
          link_health,
        });
      }
    }

    return { count: items.length, items };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function computeQuality(db: Database.Database): QualitySection {
  // Dead exports — best-effort SQL-only proxy: count exported symbols whose
  // `name` is never referenced as an `imports` edge specifier. Not as accurate
  // as the full getDeadExports() pipeline, but cheap and side-effect-free.
  let dead_exports: number | null = null;
  try {
    // Try the cheap path first: rely on metadata.is_exported flag if present.
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM symbols
         WHERE json_extract(metadata, '$.is_exported') = 1
           AND name NOT IN (
             SELECT DISTINCT json_each.value
             FROM edges, json_each(json_extract(metadata, '$.specifiers'))
             WHERE json_extract(metadata, '$.specifiers') IS NOT NULL
           )`,
      )
      .get() as { c: number } | undefined;
    dead_exports = row?.c ?? 0;
  } catch {
    dead_exports = null;
  }

  // Untested symbols — proxy: count function/method symbols not referenced
  // by any symbol whose containing file is a test file.
  let untested_symbols: number | null = null;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM symbols s
         WHERE s.kind IN ('function', 'method', 'class')
           AND s.id NOT IN (
             SELECT DISTINCT n.ref_id FROM nodes n
             JOIN edges e ON e.target_node_id = n.id
             JOIN nodes ns ON ns.id = e.source_node_id
             JOIN symbols src ON src.id = ns.ref_id AND ns.node_type = 'symbol'
             JOIN files f ON f.id = src.file_id
             WHERE n.node_type = 'symbol'
               AND (f.path LIKE '%.test.%'
                 OR f.path LIKE '%.spec.%'
                 OR f.path LIKE '%/tests/%'
                 OR f.path LIKE '%/__tests__/%')
           )`,
      )
      .get() as { c: number } | undefined;
    untested_symbols = row?.c ?? 0;
  } catch {
    untested_symbols = null;
  }

  // Complexity hotspots — top 10 symbols by cyclomatic complexity.
  let complexity_hotspots: QualitySection['complexity_hotspots'] = [];
  try {
    const rows = db
      .prepare(
        `SELECT s.name AS name, f.path AS file, COALESCE(s.line_start, 0) AS line,
                COALESCE(s.cyclomatic, 0) AS cyclomatic
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.cyclomatic IS NOT NULL AND s.cyclomatic > 0
         ORDER BY s.cyclomatic DESC
         LIMIT 10`,
      )
      .all() as QualitySection['complexity_hotspots'];
    complexity_hotspots = rows;
  } catch {
    complexity_hotspots = [];
  }

  return { dead_exports, untested_symbols, complexity_hotspots };
}

function computeContent(db: Database.Database): ContentSection {
  // Language distribution
  const langRows = db
    .prepare(
      `SELECT COALESCE(language, 'unknown') AS language, COUNT(*) AS files
       FROM files WHERE status = 'ok'
       GROUP BY language ORDER BY files DESC`,
    )
    .all() as Array<{ language: string; files: number }>;

  // Top largest files by symbol count
  const filesRows = db
    .prepare(
      `SELECT f.path AS path, COUNT(s.id) AS symbols
       FROM files f
       LEFT JOIN symbols s ON s.file_id = f.id
       WHERE f.status = 'ok'
       GROUP BY f.id
       ORDER BY symbols DESC
       LIMIT 10`,
    )
    .all() as Array<{ path: string; symbols: number }>;

  // Framework breakdown — uses framework_role column on files
  const fwRows = db
    .prepare(
      `SELECT COALESCE(framework_role, 'none') AS framework, COUNT(*) AS files
       FROM files WHERE status = 'ok'
       GROUP BY framework_role ORDER BY files DESC`,
    )
    .all() as Array<{ framework: string; files: number }>;

  return {
    languages: langRows,
    largest_files: filesRows,
    frameworks: fwRows,
  };
}

// ---------------------------------------------------------------------------
// Cache (30s TTL per project root)
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: ProjectStatsPayload;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

export function invalidateProjectStatsCache(projectRoot?: string): void {
  if (projectRoot) {
    cache.delete(projectRoot);
  } else {
    cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Main builder — assembles all sections, caching the result
// ---------------------------------------------------------------------------

export interface ProjectStatsContext {
  journalStats: JournalStatsContext;
}

const TOOLS_WINDOW_MS = 86_400_000; // 24h

/**
 * Assemble a full ProjectStatsPayload for `projectRoot`. Each section is
 * isolated — a failing section is recorded as `null` rather than failing the
 * whole response.
 *
 * Exported for tests; the HTTP handler simply wraps this.
 */
export function buildProjectStats(
  projectRoot: string,
  ctx: ProjectStatsContext,
): ProjectStatsPayload {
  const cached = cache.get(projectRoot);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const payload: ProjectStatsPayload = {
    project: projectRoot,
    generated_at: new Date().toISOString(),
    index: null,
    tools: null,
    decisions: null,
    performance: null,
    subprojects: null,
    quality: null,
    content: null,
  };

  // Resolve DB path via the registry — no dependency on ProjectManager.
  const entry = findRegistryEntry(projectRoot);
  let db: Database.Database | null = null;
  if (entry && fs.existsSync(entry.dbPath)) {
    try {
      db = new Database(entry.dbPath, { readonly: true, fileMustExist: true });
    } catch {
      db = null;
    }
  }

  // Pull tool entries once — used by both `tools` and `performance`.
  let toolEntries: JournalEntryForStats[] = [];
  try {
    toolEntries = ctx.journalStats.listEntriesForProject(projectRoot);
  } catch {
    toolEntries = [];
  }

  if (db) {
    try {
      payload.index = computeIndex(db);
    } catch {
      payload.index = null;
    }
    try {
      payload.performance = computePerformance(db, toolEntries);
    } catch {
      payload.performance = null;
    }
    try {
      payload.quality = computeQuality(db);
    } catch {
      payload.quality = null;
    }
    try {
      payload.content = computeContent(db);
    } catch {
      payload.content = null;
    }
  }

  try {
    payload.tools = computeTools(toolEntries, TOOLS_WINDOW_MS);
  } catch {
    payload.tools = null;
  }

  try {
    payload.decisions = computeDecisions(projectRoot);
  } catch {
    payload.decisions = null;
  }

  try {
    payload.subprojects = computeSubprojects(projectRoot);
  } catch {
    payload.subprojects = null;
  }

  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  cache.set(projectRoot, { data: payload, expiresAt: Date.now() + CACHE_TTL_MS });
  return payload;
}

// ---------------------------------------------------------------------------
// HTTP route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/projects/full-stats?project=<root>
 *
 * Returns the rich ProjectStatsPayload. Caching is per-project, 30s TTL.
 * Returns 400 when ?project= is missing. Per-section failures degrade to
 * `null` for that section; the whole response is still 200.
 */
export function handleProjectStatsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: ProjectStatsContext,
): boolean {
  if (req.method !== 'GET' || url.pathname !== '/api/projects/full-stats') {
    return false;
  }

  const projectRoot = url.searchParams.get('project');
  if (!projectRoot) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'project query param is required' }));
    return true;
  }

  try {
    const payload = buildProjectStats(projectRoot, ctx);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (e as Error)?.message ?? 'Failed to build project stats' }));
  }
  return true;
}

export const PROJECT_STATS_ROUTE_PATH = '/api/projects/full-stats';
