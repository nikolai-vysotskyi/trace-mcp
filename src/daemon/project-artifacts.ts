/**
 * On-disk artifact cleanup for a project root.
 *
 * Why this module exists
 * ──────────────────────
 * `ProjectManager.removeProject()` historically only dropped the in-memory
 * state + registry row, leaving the per-project SQLite DB (index DB, session
 * DBs, task-cache DBs) on disk forever. The desktop app's delete button drove
 * users into multi-GB orphan accumulation because the only way to actually
 * free disk space was to run `trace-mcp remove` from the terminal — which
 * itself never deleted session DBs either.
 *
 * `removeProjectArtifacts` deletes everything keyed to a single project root
 * and is idempotent: running it twice is safe, missing files are silently
 * skipped, and a partial delete on one tier (e.g. topology) does not abort
 * the other tiers.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { hasLiveHolderOrUnknown, removeHoldersDir } from '../db-holders.js';
import { DECISIONS_DB_PATH, projectHash, projectName, TOPOLOGY_DB_PATH } from '../global.js';
import { logger } from '../logger.js';
import { getProject, isEphemeralProjectRoot, listProjects } from '../registry.js';
import { INDEX_DIR } from '../shared/paths.js';

/** A tier that failed outright (as opposed to finding nothing to clean up). */
export interface ArtifactFailure {
  /** Which cleanup tier failed, e.g. "index_db", "topology", "decisions.session_chunks". */
  tier: string;
  /** The underlying error, stringified. */
  error: string;
}

/** Result of a project artifact cleanup pass. */
export interface RemoveArtifactsResult {
  /** Absolute paths that were deleted. */
  deleted: string[];
  /** Absolute paths considered but left in place (e.g. when keepDbFiles=true). */
  kept: string[];
  /** Total bytes freed by the delete operations. */
  freedBytes: number;
  /** Topology rows dropped, if any. */
  topology: { subprojects: number; services: number };
  /** Decision-store rows dropped for this project_root, if any. */
  decisions: { decisions: number; chunks: number; clusters: number; memos: number };
  /**
   * Tiers that threw instead of completing, distinct from a tier that ran
   * and genuinely found nothing to do. A zero count next to a failures entry
   * for the same tier means "the driver wouldn't load", not "nothing here".
   */
  failures: ArtifactFailure[];
}

/** Options for {@link removeProjectArtifacts}. */
export interface RemoveArtifactsOptions {
  /** When true, do NOT delete index DB / session DBs / task-cache DBs.
   *  Still drops topology + decision rows + analytics rows. Default false. */
  keepDbFiles?: boolean;
}

/** SQLite sidecars that may exist next to a `.db` file. */
const SQLITE_SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

function tryUnlink(file: string): { deleted: boolean; bytes: number; error?: string } {
  try {
    const stat = fs.statSync(file);
    fs.unlinkSync(file);
    return { deleted: true, bytes: stat.size };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { deleted: false, bytes: 0 };
    logger.error({ file, err }, 'project-artifacts: unlink failed');
    return { deleted: false, bytes: 0, error: String(err) };
  }
}

function deleteDbWithSidecars(basePath: string, result: RemoveArtifactsResult, tier: string): void {
  for (const suffix of SQLITE_SIDECARS) {
    const full = basePath + suffix;
    const { deleted, bytes, error } = tryUnlink(full);
    if (deleted) {
      result.deleted.push(full);
      result.freedBytes += bytes;
    }
    if (error) result.failures.push({ tier, error: `${full}: ${error}` });
  }
}

function listIndexDirFiles(result: RemoveArtifactsResult): string[] {
  try {
    return fs.readdirSync(INDEX_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    logger.error({ err }, 'project-artifacts: failed to list INDEX_DIR');
    result.failures.push({ tier: 'index_dir_list', error: String(err) });
    return [];
  }
}

function dropTopologyRows(
  root: string,
  result: RemoveArtifactsResult,
): { subprojects: number; services: number } {
  if (!fs.existsSync(TOPOLOGY_DB_PATH)) return { subprojects: 0, services: 0 };
  try {
    // Lazy import to avoid pulling better-sqlite3 unless a topology DB exists.
    // The store opens with a single writer connection — safe to close immediately.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TopologyStore } =
      require('../topology/topology-db.js') as typeof import('../topology/topology-db.js');
    const store = new TopologyStore(TOPOLOGY_DB_PATH);
    try {
      return store.removeByRepoRoot(root);
    } finally {
      store.close();
    }
  } catch (err) {
    logger.error({ err, root }, 'project-artifacts: topology cleanup failed');
    result.failures.push({ tier: 'topology', error: String(err) });
    return { subprojects: 0, services: 0 };
  }
}

/**
 * Drop topology rows left behind by one-shot agent-run checkouts (TRA-527).
 *
 * These have no registry row and no owner, so `removeProjectArtifacts` is never
 * called for them — the rows just accumulate in the global topology DB (260 of
 * 320 distinct project roots on the reported machine) and widen the fan-out of
 * every scoped topology query. Auto-discovery now skips such roots, so this
 * only has to drain what earlier versions wrote. Returns the repo roots dropped.
 */
export async function sweepEphemeralTopology(): Promise<string[]> {
  if (!fs.existsSync(TOPOLOGY_DB_PATH)) return [];
  const dropped: string[] = [];
  try {
    // Lazy import for the same reason as dropTopologyRows(): don't pull
    // better-sqlite3 in unless there is a topology DB to open.
    const { TopologyStore } = await import('../topology/topology-db.js');
    const store = new TopologyStore(TOPOLOGY_DB_PATH);
    try {
      for (const sub of store.getAllSubprojects()) {
        if (!isEphemeralProjectRoot(sub.project_root || sub.repo_root)) continue;
        store.removeByRepoRoot(sub.repo_root);
        dropped.push(sub.repo_root);
      }
    } finally {
      store.close();
    }
  } catch (err) {
    logger.error({ err }, 'project-artifacts: ephemeral topology sweep failed');
  }
  return dropped;
}

interface DecisionDeleteCounts {
  decisions: number;
  chunks: number;
  clusters: number;
  memos: number;
}

function dropDecisionRows(root: string, result: RemoveArtifactsResult): DecisionDeleteCounts {
  const empty: DecisionDeleteCounts = { decisions: 0, chunks: 0, clusters: 0, memos: 0 };
  if (!fs.existsSync(DECISIONS_DB_PATH)) return empty;
  try {
    // Use raw SQLite — DecisionStore would re-run migrations / open a writer
    // pool we don't need just to issue four DELETEs. The schema is stable
    // (project_root TEXT NOT NULL on every project-scoped table).
    // createRequire, not a bare `require`: the ESM bundle rewrites a bare
    // `require('better-sqlite3')` into the module namespace object, so
    // `new Database(...)` threw "Database is not a constructor" in every
    // shipped build while passing under vitest.
    const Database = createRequire(import.meta.url)(
      'better-sqlite3',
    ) as typeof import('better-sqlite3');
    const db = new Database(DECISIONS_DB_PATH);
    try {
      const counts: DecisionDeleteCounts = { ...empty };
      const tables: Array<{ table: string; key: keyof DecisionDeleteCounts }> = [
        { table: 'decisions', key: 'decisions' },
        { table: 'session_chunks', key: 'chunks' },
        { table: 'decision_clusters', key: 'clusters' },
        { table: 'project_memos', key: 'memos' },
      ];
      for (const { table, key } of tables) {
        try {
          const info = db.prepare(`DELETE FROM ${table} WHERE project_root = ?`).run(root);
          counts[key] = Number(info.changes ?? 0);
        } catch (err) {
          // Table may not exist on older DBs — ignore.
          const msg = (err as Error)?.message ?? '';
          if (!/no such table/i.test(msg)) {
            logger.error({ err, table, root }, 'project-artifacts: decision table delete failed');
            result.failures.push({ tier: `decisions.${table}`, error: String(err) });
          }
        }
      }
      return counts;
    } finally {
      db.close();
    }
  } catch (err) {
    logger.error({ err, root }, 'project-artifacts: decision cleanup failed');
    result.failures.push({ tier: 'decisions', error: String(err) });
    return empty;
  }
}

/**
 * Delete every on-disk artifact tied to a project root.
 *
 * Idempotent: missing files / missing rows are not errors. A partial failure
 * on one tier (e.g. decisions DB locked) does not abort the others.
 *
 * The caller is responsible for closing any open SQLite handles for `root`
 * BEFORE invoking this function — ProjectManager.removeProject does that via
 * stopProject → resourcePool.disposeProject. On Unix the DB unlink would
 * succeed regardless (the handle keeps the inode alive); on Windows the
 * unlink would fail with EBUSY.
 */
export function removeProjectArtifacts(
  root: string,
  options: RemoveArtifactsOptions = {},
): RemoveArtifactsResult {
  const absRoot = path.resolve(root);
  const result: RemoveArtifactsResult = {
    deleted: [],
    kept: [],
    freedBytes: 0,
    topology: { subprojects: 0, services: 0 },
    decisions: { decisions: 0, chunks: 0, clusters: 0, memos: 0 },
    failures: [],
  };

  // TRA-38: use the registry's own recorded dbPath, not a fresh
  // name+hash recomputation. Since two checkouts of the same git remote can
  // now share one dbPath (see registerProject in registry.ts), `absRoot`'s
  // actual DB may live at a path derived from a *different* root's hash —
  // recomputing from absRoot would silently miss it (and miss the
  // session/task-cache files, which are themselves named off this same
  // dbPath — see local-backend.ts's `sharedDbPath.replace(/\.db$/, ...)`).
  const registryEntry = getProject(absRoot);
  const indexDbBase =
    registryEntry?.dbPath ??
    path.join(INDEX_DIR, `${projectName(absRoot)}-${projectHash(absRoot)}.db`);
  const dbBasenameMatch = path.basename(indexDbBase).match(/^(.+)-([0-9a-f]{12})\.db$/i);
  const name = dbBasenameMatch ? dbBasenameMatch[1] : projectName(absRoot);
  const hash = dbBasenameMatch ? dbBasenameMatch[2] : projectHash(absRoot);

  // This dbPath may still be in use by another registered project (a TRA-38
  // sibling checkout of the same remote). Deleting it out from under that
  // sibling would silently force it into a full reindex the next time it's
  // opened, so never delete the index DB itself while another registered
  // entry still points at it — its own topology/decision rows and
  // session/task-cache files are still cleaned up below regardless.
  const sharedWithSibling = listProjects().some(
    (e) => path.resolve(e.root) !== absRoot && e.dbPath === indexDbBase,
  );
  // TRA-304: a live holder marker from another root means some process has
  // this DB open right now, even if that root left no registry entry. Same
  // rule, same reason — an unreadable holder dir counts as "in use".
  const heldByOther = hasLiveHolderOrUnknown(indexDbBase, absRoot);

  if (options.keepDbFiles || sharedWithSibling || heldByOther) {
    // Inventory what we'd have deleted so callers can report it.
    for (const suffix of SQLITE_SIDECARS) {
      const full = indexDbBase + suffix;
      if (fs.existsSync(full)) result.kept.push(full);
    }
  } else {
    // 1. Index DB + WAL/SHM/journal sidecars
    deleteDbWithSidecars(indexDbBase, result, 'index_db');
    // Nothing holds a DB that no longer exists.
    removeHoldersDir(indexDbBase);
  }

  if (!options.keepDbFiles) {
    // 2. Session DBs: `<name>-<hash>-session-*.db` (+ sidecars)
    // 3. Daemon task cache DBs: `daemon-task-cache-*-<hash>.db` (+ sidecars)
    // Always cleaned up regardless of index-DB sharing — these are
    // per-connection caches, cheap to lose and rebuilt on next use, unlike
    // the index DB itself.
    const sessionPrefix = `${name}-${hash}-session-`;
    const taskCacheSuffix = `-${hash}.db`;
    const taskCachePrefix = 'daemon-task-cache-';
    const seenBases = new Set<string>();
    for (const file of listIndexDirFiles(result)) {
      let base: string | null = null;
      if (file.startsWith(sessionPrefix) && /\.db(-wal|-shm|-journal)?$/.test(file)) {
        base = file.replace(/(-wal|-shm|-journal)$/, '');
      } else if (
        file.startsWith(taskCachePrefix) &&
        file.endsWith(taskCacheSuffix) &&
        /\.db(-wal|-shm|-journal)?$/.test(file)
      ) {
        base = file.replace(/(-wal|-shm|-journal)$/, '');
      }
      if (!base || seenBases.has(base)) continue;
      seenBases.add(base);
      deleteDbWithSidecars(path.join(INDEX_DIR, base), result, 'session_task_cache_db');
    }
  }

  // 4. Topology rows
  result.topology = dropTopologyRows(absRoot, result);

  // 5. Decisions DB project-scoped rows
  result.decisions = dropDecisionRows(absRoot, result);

  logger.info(
    {
      root: absRoot,
      deletedFiles: result.deleted.length,
      keptFiles: result.kept.length,
      freedBytes: result.freedBytes,
      topology: result.topology,
      decisions: result.decisions,
      failures: result.failures,
    },
    result.failures.length > 0
      ? 'project-artifacts: cleanup completed with failures'
      : 'project-artifacts: cleanup complete',
  );

  return result;
}
