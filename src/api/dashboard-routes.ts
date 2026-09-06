/**
 * Dashboard API routes — aggregate health overview across all registered projects.
 *
 * Endpoint: GET /api/dashboard/projects
 * Returns: { projects: ProjectHealth[], computing: boolean, computedAt: number }
 *
 * Endpoint: POST /api/dashboard/refresh
 * Returns: 200 — starts a background recompute.
 *
 * The GET never computes (TRA-1053). It answers out of a cache that a
 * background pass fills, so it costs ~1 ms whatever the workspace size. It
 * used to run every project's dead-export / untested / tech-debt / security
 * analysis inline — 20.5 s of synchronous SQLite across 38 registered
 * projects on the measuring machine, past the renderer's 8 s ceiling
 * (`daemon-fetch.ts`) and holding the daemon's only thread for the duration,
 * so /health and every other route were starved with it. The `Promise.all`
 * that used to wrap it was decorative: each callback was synchronous.
 *
 * Each ProjectHealth entry is computed by opening the project's SQLite DB
 * directly (read-only). Does NOT depend on ProjectManager — safe to call
 * even if a project is not currently loaded by the daemon.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';
import { REGISTRY_PATH, TRACE_MCP_HOME } from '../global.js';
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

const ZERO = {
  totalFiles: 0,
  totalSymbols: 0,
  totalEdges: 0,
  deadExports: 0,
  untestedSymbols: 0,
  securityFindings: 0,
} as const;

/** Hand the event loop back so /health and the rest of the routes stay answerable. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Pass 1: three COUNT(*) queries. Measured at ~7 ms per project across a
 * 38-project registry, so the whole first pass lands inside a second and the
 * screen gets real file/symbol numbers while the expensive metrics are still
 * being computed behind it.
 */
function queryBasics(entry: RegistryEntry): ProjectHealth {
  const base = {
    root: entry.root,
    name: entry.name,
    lastIndexed: entry.lastIndexed,
    ...ZERO,
  };

  if (!fs.existsSync(entry.dbPath)) return { ...base, status: 'not_loaded' };

  let db: Database.Database | undefined;
  try {
    db = new Database(entry.dbPath, { readonly: true, fileMustExist: true });
    return {
      ...base,
      status: 'ok',
      totalFiles:
        (db.prepare("SELECT COUNT(*) AS c FROM files WHERE status = 'ok'").get() as { c: number })
          ?.c ?? 0,
      totalSymbols:
        (db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number })?.c ?? 0,
      totalEdges: (db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number })?.c ?? 0,
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
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

/**
 * Pass 2: the four real analyses. Each is a full-table scan and the four
 * together are ~500 ms on a mid-sized project — hence a `tick()` between
 * them rather than one per project.
 *
 * ponytail: the ceiling here is a single analysis, ~800 ms measured worst
 * case, which is still one blocked turn of the event loop. Move the whole
 * pass to a worker thread if that ever shows up in a /health latency trace.
 */
async function enrich(entry: RegistryEntry, basics: ProjectHealth): Promise<ProjectHealth> {
  let db: Database.Database | undefined;
  try {
    const opened = openStore(entry.dbPath);
    db = opened.db;
    const store = opened.store;
    const out: ProjectHealth = { ...basics, status: 'ok' };

    // getDeadExports returns { total_dead, dead_exports[] } scoped to non-test files.
    try {
      out.deadExports = getDeadExports(store).total_dead;
    } catch {
      /* leave 0 */
    }
    await tick();

    // Count only 'unreached' (TRA-515): 'imported_not_called' is a direct-call-edge
    // artefact that inflates the figure to ~95% of the codebase on any real repo.
    try {
      out.untestedSymbols = getUntestedSymbols(store).by_level.unreached;
    } catch {
      /* leave 0 */
    }
    await tick();

    try {
      const debtResult = getTechDebt(store, entry.root, {});
      if (debtResult.isOk()) out.techDebtGrade = debtResult.value.project_grade;
    } catch {
      /* leave undefined */
    }
    await tick();

    // Count only critical + high findings.
    try {
      const secResult = scanSecurity(store, entry.root, { rules: ['all'] });
      if (secResult.isOk()) {
        out.securityFindings =
          (secResult.value.summary.critical ?? 0) + (secResult.value.summary.high ?? 0);
      }
    } catch {
      /* leave 0 */
    }

    return out;
  } catch (err) {
    return {
      ...basics,
      status: 'error',
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
// Cache — in memory, mirrored to disk
// ---------------------------------------------------------------------------

/**
 * Persisting the cache is what stops every cold start landing on the
 * "these are the last indexed numbers" banner: a daemon restart re-reads the
 * last computed snapshot in ~1 ms and revalidates behind it, instead of
 * re-entering the full recompute with the renderer waiting on it.
 */
const DASHBOARD_CACHE_PATH = path.join(TRACE_MCP_HOME, 'dashboard-cache.json');
const CACHE_TTL_MS = 300_000; // 5 minutes

const cache = new Map<string, ProjectHealth>();
/** dbPath fingerprint at the time each project's expensive pass last ran. */
const enrichedAt = new Map<string, number>();
let computedAt = 0;
let computing = false;
let loadedFromDisk = false;

function loadCacheFromDisk(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const raw = JSON.parse(fs.readFileSync(DASHBOARD_CACHE_PATH, 'utf-8')) as {
      computedAt?: number;
      projects?: ProjectHealth[];
      enrichedAt?: Array<[string, number]>;
    };
    for (const p of raw.projects ?? []) if (p?.root) cache.set(p.root, p);
    for (const [root, at] of raw.enrichedAt ?? []) enrichedAt.set(root, at);
    if (typeof raw.computedAt === 'number') computedAt = raw.computedAt;
  } catch {
    /* no usable cache on disk — the first background pass writes one */
  }
}

function saveCacheToDisk(): void {
  try {
    const tmp = `${DASHBOARD_CACHE_PATH}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        computedAt,
        projects: [...cache.values()],
        enrichedAt: [...enrichedAt],
      }),
    );
    fs.renameSync(tmp, DASHBOARD_CACHE_PATH);
  } catch {
    /* best effort — the in-memory cache still serves this process */
  }
}

/**
 * Background recompute. Never awaited by a request.
 *
 * `force` re-runs the expensive pass even for projects whose index has not
 * moved — what the explicit Refresh button asks for. Left alone, the pass
 * skips them: the renderer re-asks every five minutes for as long as it is
 * open, and recomputing an unchanged index is ~19 s of SQLite producing the
 * numbers already in the cache.
 */
async function refreshAll(force = false): Promise<void> {
  if (computing) return;
  computing = true;
  try {
    const entries = Object.values(readRegistry().projects);
    const roots = new Set(entries.map((e) => e.root));
    for (const root of [...cache.keys()])
      if (!roots.has(root)) {
        cache.delete(root);
        enrichedAt.delete(root);
      }

    const stale = new Set<string>();
    const fingerprints = new Map<string, number>();

    // Pass 1 — cheap counts for everything, so numbers appear early.
    for (const entry of entries) {
      const prev = cache.get(entry.root);
      const basics = queryBasics(entry);
      // Fingerprint *after* the open above: a read-only open of a WAL database
      // creates the `-wal` sidecar if it is missing, so taking it first would
      // record a pre-creation value and force one redundant pass.
      const fingerprint = indexFingerprint(entry.dbPath);
      fingerprints.set(entry.root, fingerprint);
      if (
        force ||
        prev === undefined ||
        prev.status !== 'ok' ||
        enrichedAt.get(entry.root) !== fingerprint
      ) {
        stale.add(entry.root);
      }
      cache.set(entry.root, {
        ...basics,
        // Carry the previous run's expensive metrics rather than blanking the
        // screen back to zeros while pass 2 recomputes them.
        deadExports: prev?.deadExports ?? 0,
        untestedSymbols: prev?.untestedSymbols ?? 0,
        securityFindings: prev?.securityFindings ?? 0,
        techDebtGrade: prev?.techDebtGrade,
        status: basics.status === 'ok' && prev === undefined ? 'computing' : basics.status,
      });
      await tick();
    }

    // Pass 2 — the expensive analyses, one project at a time.
    for (const entry of entries) {
      if (!stale.has(entry.root)) continue;
      const basics = cache.get(entry.root);
      if (!basics || basics.status === 'not_loaded' || basics.status === 'error') continue;
      const enriched = await enrich(entry, basics);
      cache.set(entry.root, enriched);
      if (enriched.status === 'ok') enrichedAt.set(entry.root, fingerprints.get(entry.root) ?? 0);
      await tick();
    }

    computedAt = Date.now();
    saveCacheToDisk();
  } finally {
    computing = false;
  }
}

function placeholder(entry: RegistryEntry): ProjectHealth {
  return {
    root: entry.root,
    name: entry.name,
    lastIndexed: entry.lastIndexed,
    status: 'computing',
    ...ZERO,
  };
}

/**
 * Cheapest honest answer to "has this index moved since we last analysed it".
 *
 * Not `RegistryEntry.lastIndexed`: that is written once, at registration and
 * daemon-startup indexing, and never again — the file watcher's `indexFiles()`
 * path does not touch it. Keying off it froze every actively-edited project's
 * metrics for the life of the daemon, with `status: 'ok'` and nothing on
 * screen to say so. The codebase already documents that trap in
 * `project-manager.ts` and the TRA-468 note in `pipeline.ts`; this is the
 * third place to walk into it.
 *
 * The `-wal` sidecar is included because the index is written in WAL mode, so
 * the main DB file's mtime only moves on checkpoint. `-shm` is deliberately
 * excluded: it moves on every *read*, including ours, which would make this
 * pass permanently invalidate itself.
 */
export function indexFingerprint(dbPath: string): number {
  let newest = 0;
  for (const p of [dbPath, `${dbPath}-wal`]) {
    try {
      newest = Math.max(newest, fs.statSync(p).mtimeMs);
    } catch {
      /* absent sidecar is normal */
    }
  }
  return newest;
}

/**
 * Read the cache, kicking off a background refresh when it has gone stale.
 *
 * `computedAt` goes out with the numbers (0 = never computed). Since the cache
 * survives a daemon restart, the screen can now be handed values it has no
 * other way to date — and a stale value that says how stale it is works, while
 * one that is silent about it is the trap TRA-1072 and TRA-695 are both about.
 */
function snapshot(): { projects: ProjectHealth[]; computing: boolean; computedAt: number } {
  loadCacheFromDisk();
  const entries = Object.values(readRegistry().projects);
  const projects = entries.map((e) => cache.get(e.root) ?? placeholder(e));
  if (!computing && Date.now() - computedAt > CACHE_TTL_MS) void refreshAll();
  return { projects, computing, computedAt };
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

  // GET /api/dashboard/projects — cache read only; never computes inline.
  if (req.method === 'GET' && url.pathname === '/api/dashboard/projects') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot()));
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

  // POST /api/dashboard/refresh — starts a background recompute and returns.
  if (req.method === 'POST' && url.pathname === '/api/dashboard/refresh') {
    computedAt = 0;
    void refreshAll(true);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}
