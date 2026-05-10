/**
 * Dashboard API routes — aggregate health overview across all registered projects.
 *
 * Endpoint: GET /api/dashboard/projects
 * Returns: { projects: ProjectHealth[] }
 *
 * Endpoint: POST /api/dashboard/refresh
 * Returns: 200 — invalidates the cache so the next GET recomputes metrics.
 *
 * Each ProjectHealth entry is computed by opening the project's SQLite DB
 * directly (read-only). Does NOT depend on ProjectManager — safe to call
 * even if a project is not currently loaded by the daemon.
 */

import fs from 'node:fs';
import http from 'node:http';
import Database from 'better-sqlite3';
import { REGISTRY_PATH } from '../global.js';
import { Store } from '../db/store.js';
import { getDeadExports, getUntestedSymbols } from '../tools/analysis/introspect.js';
import { getTechDebt } from '../tools/analysis/predictive-intelligence.js';
import { scanSecurity } from '../tools/quality/security-scan.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TechDebtGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface ProjectHealth {
  root: string;
  name: string;
  status: 'ok' | 'error' | 'indexing' | 'not_loaded' | 'computing';
  lastIndexed: string | null;
  totalFiles: number;
  totalSymbols: number;
  totalEdges: number;
  deadExports: number;
  untestedSymbols: number;
  techDebtGrade?: TechDebtGrade;
  securityFindings: number;
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
// Per-project metrics using real tooling
// ---------------------------------------------------------------------------

/**
 * Open the project's SQLite DB read-only and wrap it in a Store so that
 * the real analysis tools (getDeadExports, getUntestedSymbols, getTechDebt,
 * scanSecurity) can be called against it.
 *
 * The caller is responsible for calling db.close() in a finally block.
 */
function openStore(dbPath: string): { db: Database.Database; store: Store } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const store = new Store(db);
  return { db, store };
}

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
      securityFindings: 0,
    };
  }

  let db: Database.Database | undefined;
  try {
    const opened = openStore(entry.dbPath);
    db = opened.db;
    const store = opened.store;

    // ── Basic counts ─────────────────────────────────────────────────────────

    const totalFiles =
      (db.prepare("SELECT COUNT(*) AS c FROM files WHERE status = 'ok'").get() as { c: number })
        ?.c ?? 0;
    const totalSymbols =
      (db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number })?.c ?? 0;
    const totalEdges =
      (db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number })?.c ?? 0;

    // ── Dead exports (real implementation) ───────────────────────────────────
    // getDeadExports returns { total_dead, dead_exports[] } scoped to non-test files.
    let deadExports = 0;
    try {
      const deadResult = getDeadExports(store);
      deadExports = deadResult.total_dead;
    } catch {
      // fallback: leave 0
    }

    // ── Untested symbols (real implementation) ────────────────────────────────
    // getUntestedSymbols classifies 'unreached' + 'imported_not_called'; sum both.
    let untestedSymbols = 0;
    try {
      const untestedResult = getUntestedSymbols(store);
      untestedSymbols =
        untestedResult.by_level.unreached + untestedResult.by_level.imported_not_called;
    } catch {
      // fallback: leave 0
    }

    // ── Tech debt grade (real implementation) ────────────────────────────────
    // getTechDebt returns a TraceMcpResult<TechDebtResult> with project_grade.
    let techDebtGrade: TechDebtGrade | undefined;
    try {
      const debtResult = getTechDebt(store, entry.root, {});
      if (debtResult.isOk()) {
        techDebtGrade = debtResult.value.project_grade;
      }
    } catch {
      // fallback: leave undefined
    }

    // ── Security findings (real implementation) ───────────────────────────────
    // scanSecurity returns a TraceMcpResult<SecurityScanResult> with summary.
    // We count only critical + high findings.
    let securityFindings = 0;
    try {
      const secResult = scanSecurity(store, entry.root, { rules: ['all'] });
      if (secResult.isOk()) {
        securityFindings =
          (secResult.value.summary.critical ?? 0) + (secResult.value.summary.high ?? 0);
      }
    } catch {
      // fallback: leave 0
    }

    return {
      ...base,
      status: 'ok',
      totalFiles,
      totalSymbols,
      totalEdges,
      deadExports,
      untestedSymbols,
      techDebtGrade,
      securityFindings,
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
      securityFindings: 0,
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
// In-process cache (5 min TTL — real metrics are expensive)
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: ProjectHealth[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 300_000; // 5 minutes

function getCacheKey(): string {
  // Single key — the registry is global, not per-project
  return 'dashboard';
}

function invalidateCache(): void {
  cache.delete(getCacheKey());
}

async function fetchAllProjects(): Promise<ProjectHealth[]> {
  const key = getCacheKey();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const registry = readRegistry();
  const entries = Object.values(registry.projects);

  // Run all per-project queries in parallel; each is wrapped in try/catch internally
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

  // GET /api/dashboard/projects — returns cached project health data
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

  // POST /api/dashboard/refresh — invalidates cache so next GET recomputes
  if (req.method === 'POST' && url.pathname === '/api/dashboard/refresh') {
    invalidateCache();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}

// Re-export the path constant used by tests / the integrator
export const DASHBOARD_ROUTE_PATH = '/api/dashboard/projects';
