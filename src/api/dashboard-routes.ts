/**
 * Dashboard API routes — aggregate health overview across all registered projects.
 *
 * Endpoint: GET /api/dashboard/projects
 * Returns: { projects: ProjectHealth[] }
 *
 * Each ProjectHealth entry is computed by opening the project's SQLite DB
 * directly (read-only). Does NOT depend on ProjectManager — safe to call
 * even if a project is not currently loaded by the daemon.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';
import { REGISTRY_PATH } from '../global.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TechDebtGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface ProjectHealth {
  root: string;
  name: string;
  status: 'ok' | 'error' | 'indexing' | 'not_loaded';
  lastIndexed: string | null;
  totalFiles: number;
  totalSymbols: number;
  totalEdges: number;
  deadExports: number;
  untestedSymbols: number;
  techDebtGrade?: TechDebtGrade;
  error?: string;
}

// ---------------------------------------------------------------------------
// Registry helpers (copied inline to avoid importing the full registry module
// which may have side-effects, and to stay independent of ProjectManager)
// ---------------------------------------------------------------------------

interface RegistryEntry {
  name: string;
  root: string;
  dbPath: string;
  lastIndexed: string | null;
  addedAt: string;
  type?: 'single' | 'multi-root';
  children?: string[];
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
      raw != null &&
      typeof raw === 'object' &&
      'version' in raw &&
      (raw as { version: unknown }).version === 1 &&
      'projects' in raw
    ) {
      return raw as Registry;
    }
    return { version: 1, projects: {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

// ---------------------------------------------------------------------------
// Per-project SQL queries (run directly on better-sqlite3, read-only)
// ---------------------------------------------------------------------------

/**
 * Derive a tech-debt grade from the ratio of cyclomatic complexity > 10 symbols
 * to total symbols. This is a cheap heuristic that only touches the symbols table.
 *
 * Grade thresholds (% of complex symbols):
 *   A  <  5 %
 *   B  < 15 %
 *   C  < 30 %
 *   D  < 50 %
 *   F  >= 50 %
 */
function computeGrade(db: Database.Database): TechDebtGrade {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number })?.c ?? 0;
  if (total === 0) return 'A';
  const complex =
    (
      db
        .prepare(
          'SELECT COUNT(*) AS c FROM symbols WHERE cyclomatic IS NOT NULL AND cyclomatic > 10',
        )
        .get() as { c: number }
    )?.c ?? 0;
  const ratio = complex / total;
  if (ratio < 0.05) return 'A';
  if (ratio < 0.15) return 'B';
  if (ratio < 0.3) return 'C';
  if (ratio < 0.5) return 'D';
  return 'F';
}

/**
 * Count exported symbols that have zero incoming edges.
 *
 * SQL logic:
 *   1. Restrict to symbols where metadata->>'$.exported' = 1, excluding test files.
 *   2. Left-join to nodes (node_type='symbol') and then to edges (target_node_id).
 *   3. Count rows where the edges join produced no match (i.e. e.id IS NULL).
 *
 * This mirrors the intent of getDeadExports() without using the expensive
 * import-specifier cross-reference (which requires loading all edge metadata).
 * For an MVP health overview the node-graph approximation is sufficient.
 */
const DEAD_EXPORTS_SQL = `
  SELECT COUNT(*) AS c
  FROM symbols s
  JOIN files f ON f.id = s.file_id
  LEFT JOIN nodes n ON n.node_type = 'symbol' AND n.ref_id = s.id
  LEFT JOIN edges e ON e.target_node_id = n.id
  WHERE json_extract(s.metadata, '$.exported') = 1
    AND s.kind != 'method'
    AND f.path NOT LIKE '%/test/%'
    AND f.path NOT LIKE '%/tests/%'
    AND f.path NOT LIKE '%/spec/%'
    AND f.path NOT LIKE '%.test.%'
    AND f.path NOT LIKE '%.spec.%'
    AND e.id IS NULL
`;

/**
 * Count symbols in non-test files that are NOT referenced by any test file.
 *
 * SQL logic:
 *   1. Select all testable symbols (function/method/class/interface) from source files.
 *   2. Left-join to nodes and then to edges where the SOURCE of the edge is a
 *      node whose file_id belongs to a test file (path LIKE '%.test.%' etc.).
 *   3. Count symbols for which no such test-originated edge exists.
 *
 * This is intentionally a rough heuristic — exact coverage would require
 * running the full getUntestedSymbols() algorithm. The count is for display
 * only and will never be used as a gate.
 */
const UNTESTED_SYMBOLS_SQL = `
  SELECT COUNT(*) AS c
  FROM symbols s
  JOIN files f ON f.id = s.file_id
  LEFT JOIN nodes n_src ON n_src.node_type = 'symbol' AND n_src.ref_id = s.id
  LEFT JOIN edges e ON e.target_node_id = n_src.id
  LEFT JOIN nodes n_caller ON n_caller.id = e.source_node_id
  LEFT JOIN (
    SELECT s2.id AS sid
    FROM symbols s2
    JOIN files f2 ON f2.id = s2.file_id
    WHERE f2.path LIKE '%.test.%'
       OR f2.path LIKE '%.spec.%'
       OR f2.path LIKE '%/test/%'
       OR f2.path LIKE '%/tests/%'
       OR f2.path LIKE '%/spec/%'
       OR f2.path LIKE '%/__tests__/%'
  ) tf ON tf.sid = n_caller.ref_id
  WHERE s.kind IN ('function', 'method', 'class', 'interface')
    AND f.path NOT LIKE '%.test.%'
    AND f.path NOT LIKE '%.spec.%'
    AND f.path NOT LIKE '%/test/%'
    AND f.path NOT LIKE '%/tests/%'
    AND f.path NOT LIKE '%/spec/%'
    AND f.path NOT LIKE '%/__tests__/%'
  GROUP BY s.id
  HAVING COUNT(tf.sid) = 0
`;

function queryProjectHealth(entry: RegistryEntry): ProjectHealth {
  const base: Pick<ProjectHealth, 'root' | 'name' | 'lastIndexed'> = {
    root: entry.root,
    name: entry.name,
    lastIndexed: entry.lastIndexed,
  };

  if (!fs.existsSync(entry.dbPath)) {
    return {
      ...base,
      status: 'not_loaded',
      totalFiles: 0,
      totalSymbols: 0,
      totalEdges: 0,
      deadExports: 0,
      untestedSymbols: 0,
    };
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(entry.dbPath, { readonly: true, fileMustExist: true });

    const totalFiles =
      (db.prepare("SELECT COUNT(*) AS c FROM files WHERE status = 'ok'").get() as { c: number })
        ?.c ?? 0;
    const totalSymbols =
      (db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number })?.c ?? 0;
    const totalEdges =
      (db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number })?.c ?? 0;

    const deadExports = (db.prepare(DEAD_EXPORTS_SQL).get() as { c: number })?.c ?? 0;

    const untestedSymbols = (db.prepare(UNTESTED_SYMBOLS_SQL).get() as { c: number })?.c ?? 0;

    const techDebtGrade = computeGrade(db);

    return {
      ...base,
      status: 'ok',
      totalFiles,
      totalSymbols,
      totalEdges,
      deadExports,
      untestedSymbols,
      techDebtGrade,
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      totalFiles: 0,
      totalSymbols: 0,
      totalEdges: 0,
      deadExports: 0,
      untestedSymbols: 0,
      error: (err as Error)?.message ?? 'Failed to query project DB',
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// In-process cache (60 s TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: ProjectHealth[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function getCacheKey(): string {
  // Single key — the registry is global, not per-project
  return 'dashboard';
}

async function fetchAllProjects(): Promise<ProjectHealth[]> {
  const key = getCacheKey();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const registry = readRegistry();
  const entries = Object.values(registry.projects);

  // Run all per-project queries in parallel
  const results = await Promise.all(
    entries.map((entry) => Promise.resolve(queryProjectHealth(entry))),
  );

  cache.set(key, { data: results, expiresAt: Date.now() + CACHE_TTL_MS });
  return results;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Call this function early in the CLI HTTP request handler.
 * Returns `true` if the request was handled (caller should `return`).
 * Returns `false` if the route did not match (fall through to next handler).
 *
 * Integration in src/cli.ts — add before the final 404 fallback:
 *
 *   import { handleDashboardRequest } from './api/dashboard-routes.js';
 *   // ... inside the request handler, before res.writeHead(404):
 *   if (await handleDashboardRequest(req, res)) return;
 */
export async function handleDashboardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/dashboard/projects') {
    try {
      const projects = await fetchAllProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: (err as Error)?.message ?? 'Failed to load dashboard data',
        }),
      );
    }
    return true;
  }

  return false;
}

// Re-export the path constant used by tests / the integrator
export const DASHBOARD_ROUTE_PATH = '/api/dashboard/projects';
