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
import path from 'node:path';
import { DECISIONS_DB_PATH, projectHash, projectName, TOPOLOGY_DB_PATH } from '../global.js';
import { logger } from '../logger.js';
import { INDEX_DIR } from '../shared/paths.js';

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
}

/** Options for {@link removeProjectArtifacts}. */
export interface RemoveArtifactsOptions {
  /** When true, do NOT delete index DB / session DBs / task-cache DBs.
   *  Still drops topology + decision rows + analytics rows. Default false. */
  keepDbFiles?: boolean;
}

/** SQLite sidecars that may exist next to a `.db` file. */
const SQLITE_SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

function tryUnlink(file: string): { deleted: boolean; bytes: number } {
  try {
    const stat = fs.statSync(file);
    fs.unlinkSync(file);
    return { deleted: true, bytes: stat.size };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn({ file, err }, 'project-artifacts: unlink failed');
    }
    return { deleted: false, bytes: 0 };
  }
}

function deleteDbWithSidecars(basePath: string, result: RemoveArtifactsResult): void {
  for (const suffix of SQLITE_SIDECARS) {
    const full = basePath + suffix;
    const { deleted, bytes } = tryUnlink(full);
    if (deleted) {
      result.deleted.push(full);
      result.freedBytes += bytes;
    }
  }
}

function listIndexDirFiles(): string[] {
  try {
    return fs.readdirSync(INDEX_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn({ err }, 'project-artifacts: failed to list INDEX_DIR');
    }
    return [];
  }
}

function dropTopologyRows(root: string): { subprojects: number; services: number } {
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
    logger.warn({ err, root }, 'project-artifacts: topology cleanup failed (non-fatal)');
    return { subprojects: 0, services: 0 };
  }
}

interface DecisionDeleteCounts {
  decisions: number;
  chunks: number;
  clusters: number;
  memos: number;
}

function dropDecisionRows(root: string): DecisionDeleteCounts {
  const empty: DecisionDeleteCounts = { decisions: 0, chunks: 0, clusters: 0, memos: 0 };
  if (!fs.existsSync(DECISIONS_DB_PATH)) return empty;
  try {
    // Use raw SQLite — DecisionStore would re-run migrations / open a writer
    // pool we don't need just to issue four DELETEs. The schema is stable
    // (project_root TEXT NOT NULL on every project-scoped table).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database.default(DECISIONS_DB_PATH);
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
            logger.warn({ err, table, root }, 'project-artifacts: decision table delete failed');
          }
        }
      }
      return counts;
    } finally {
      db.close();
    }
  } catch (err) {
    logger.warn({ err, root }, 'project-artifacts: decision cleanup failed (non-fatal)');
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
  };

  const name = projectName(absRoot);
  const hash = projectHash(absRoot);
  const indexDbBase = path.join(INDEX_DIR, `${name}-${hash}.db`);

  if (options.keepDbFiles) {
    // Inventory what we'd have deleted so callers can report it.
    for (const suffix of SQLITE_SIDECARS) {
      const full = indexDbBase + suffix;
      if (fs.existsSync(full)) result.kept.push(full);
    }
  } else {
    // 1. Index DB + WAL/SHM/journal sidecars
    deleteDbWithSidecars(indexDbBase, result);

    // 2. Session DBs: `<name>-<hash>-session-*.db` (+ sidecars)
    // 3. Daemon task cache DBs: `daemon-task-cache-*-<hash>.db` (+ sidecars)
    const sessionPrefix = `${name}-${hash}-session-`;
    const taskCacheSuffix = `-${hash}.db`;
    const taskCachePrefix = 'daemon-task-cache-';
    const seenBases = new Set<string>();
    for (const file of listIndexDirFiles()) {
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
      deleteDbWithSidecars(path.join(INDEX_DIR, base), result);
    }
  }

  // 4. Topology rows
  result.topology = dropTopologyRows(absRoot);

  // 5. Decisions DB project-scoped rows
  result.decisions = dropDecisionRows(absRoot);

  logger.info(
    {
      root: absRoot,
      deletedFiles: result.deleted.length,
      keptFiles: result.kept.length,
      freedBytes: result.freedBytes,
      topology: result.topology,
      decisions: result.decisions,
    },
    'project-artifacts: cleanup complete',
  );

  return result;
}
