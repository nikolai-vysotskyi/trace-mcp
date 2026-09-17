/**
 * Session DB lifecycle helpers for LocalBackend.
 *
 * Each stdio session running in local mode gets its own
 * `<project>-session-<rand>.db` so concurrent sessions never contend on one
 * writer. Two field problems with that design, both fixed here:
 *
 * 1. The session DB started EMPTY, so every stdio session re-indexed the
 *    whole project from scratch — N open Claude sessions during a daemon
 *    outage meant N full indexing runs of the same repo (observed: 7
 *    parallel `serve` processes at 100% CPU). `seedSessionDbFromShared`
 *    copies the canonical project DB via SQLite's online backup API, after
 *    which `indexAll()` degrades into a cheap hash-gated validation pass.
 *
 * 2. Session DBs are unlinked on graceful dispose only — SIGKILLed sessions
 *    leak them (observed: 60 orphaned session DBs, 1.9 GB).
 *    `sweepOrphanedSessionDbs` removes leftovers whose owning process is
 *    gone, using the `server_state.pid` row each backend writes at startup.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../../logger.js';

/** Matches `<anything>-session-<8 hex>.db` (but not -wal/-shm sidecars). */
const SESSION_DB_RE = /-session-[0-9a-f]{8}\.db$/;

/** Sidecar suffixes removed together with a session DB. */
const SIDECARS = ['', '-wal', '-shm'];

/**
 * Age past which an existing-but-empty shared DB is treated as a dead
 * daemon's leftover rather than a live daemon's work in progress. A daemon
 * doing its first index touches the file continuously, so a fresh empty
 * file means "hands off, the daemon owns it"; a stale one means nobody is
 * ever going to fill it, and a fallback-storm winner may claim it.
 */
export const STALE_EMPTY_SHARED_DB_MS = 5 * 60 * 1000;

/**
 * Age threshold for deleting session DBs whose owner PID cannot be
 * determined (corrupt/locked file, pre-migration schema). Old enough that a
 * legitimately running session is implausible.
 */
const UNKNOWN_OWNER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but not ours — alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the owning PID a backend stamped into server_state, or null. */
function readOwnerPid(dbPath: string): number | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`SELECT value FROM server_state WHERE key = 'pid'`).get() as
      | { value?: string }
      | undefined;
    if (!row?.value) return null;
    const pid = Number.parseInt(row.value, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignored */
    }
  }
}

/** Rows in `files`, or 0 when the table is missing/unreadable (fresh DB). */
function countIndexedFiles(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n?: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Seed a fresh session DB from the canonical project DB using SQLite's
 * online backup API (safe against a daemon writing concurrently). Returns
 * true when the session DB was seeded; false means "start from scratch"
 * (no shared DB yet, the shared DB holds no indexed files, or the copy failed —
 * any partial file is removed).
 */
export async function seedSessionDbFromShared(
  sharedDbPath: string,
  sessionDbPath: string,
): Promise<boolean> {
  if (!fs.existsSync(sharedDbPath)) return false;
  let src: Database.Database | null = null;
  try {
    src = new Database(sharedDbPath, { readonly: true, fileMustExist: true });
    // An empty shared DB is not a snapshot worth having. Project registration
    // creates the file before anything is indexed, so on a daemonless machine
    // the first session would otherwise seed itself from zero files, latch
    // read-only on the strength of "seeded", and serve an empty index forever —
    // no indexAll, no watcher (TRA-931).
    if (countIndexedFiles(src) === 0) return false;
    await src.backup(sessionDbPath);
    return true;
  } catch (err) {
    logger.warn(
      { sharedDbPath, error: String(err) },
      'Session DB seeding failed — falling back to a fresh index',
    );
    for (const suffix of SIDECARS) {
      try {
        fs.rmSync(sessionDbPath + suffix, { force: true });
      } catch {
        /* ignored */
      }
    }
    return false;
  } finally {
    try {
      src?.close();
    } catch {
      /* ignored */
    }
  }
}

/**
 * Publish a fallback-storm winner's freshly indexed session DB as the shared
 * project DB, so losing siblings can seed from it instead of each running
 * their own full index (TRA-1605).
 *
 * Never clobbers a real index: publishes only when the shared DB is missing,
 * or exists with zero indexed files AND is older than `staleEmptyMs` (a
 * fresh empty file is a live daemon's first index in progress — hands off).
 * Also refuses to publish an empty session DB. Returns true when the shared
 * DB now holds this session's index. Never throws.
 */
export async function publishSessionDbToShared(
  sharedDbPath: string,
  sessionDbPath: string,
  opts: { staleEmptyMs?: number } = {},
): Promise<boolean> {
  const staleEmptyMs = opts.staleEmptyMs ?? STALE_EMPTY_SHARED_DB_MS;
  try {
    if (fs.existsSync(sharedDbPath)) {
      let dst: Database.Database | null = null;
      try {
        dst = new Database(sharedDbPath, { readonly: true, fileMustExist: true });
        if (countIndexedFiles(dst) > 0) return false;
      } catch {
        // Unreadable shared DB (locked, corrupt, mid-write): never overwrite
        // what we cannot even read — the daemon may own it.
        return false;
      } finally {
        try {
          dst?.close();
        } catch {
          /* ignored */
        }
      }
      let ageMs = Number.POSITIVE_INFINITY;
      try {
        ageMs = Date.now() - fs.statSync(sharedDbPath).mtimeMs;
      } catch {
        return false;
      }
      if (!(ageMs > staleEmptyMs)) return false;
    }
    let src: Database.Database | null = null;
    try {
      src = new Database(sessionDbPath, { readonly: true, fileMustExist: true });
      if (countIndexedFiles(src) === 0) return false;
      await src.backup(sharedDbPath);
      return true;
    } finally {
      try {
        src?.close();
      } catch {
        /* ignored */
      }
    }
  } catch (err) {
    logger.warn(
      { sharedDbPath, error: String(err) },
      'Winner session could not publish its index to the shared DB — siblings will index on their own',
    );
    return false;
  }
}

/**
 * Delete orphaned session DBs in `indexDir`. A session DB is an orphan when
 * its `server_state.pid` points at a dead process; when the owner cannot be
 * read at all, fall back to an age check. Live sessions are never touched.
 * Best-effort: every failure skips the file rather than throwing.
 */
export function sweepOrphanedSessionDbs(indexDir: string): {
  scanned: number;
  removed: number;
} {
  let scanned = 0;
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(indexDir);
  } catch {
    return { scanned, removed };
  }

  for (const name of names) {
    if (!SESSION_DB_RE.test(name)) continue;
    scanned++;
    const dbPath = path.join(indexDir, name);

    const ownerPid = readOwnerPid(dbPath);
    let orphaned: boolean;
    if (ownerPid !== null) {
      orphaned = !processIsAlive(ownerPid);
    } else {
      // Unreadable owner (corrupt, locked, ancient schema) — only reclaim
      // when the file is old enough that a live session is implausible.
      try {
        orphaned = Date.now() - fs.statSync(dbPath).mtimeMs > UNKNOWN_OWNER_MAX_AGE_MS;
      } catch {
        orphaned = false;
      }
    }
    if (!orphaned) continue;

    let removedThis = false;
    for (const suffix of SIDECARS) {
      try {
        fs.rmSync(dbPath + suffix, { force: true });
        removedThis = true;
      } catch {
        /* in use or permission — leave it */
      }
    }
    if (removedThis) removed++;
  }

  if (removed > 0) {
    logger.info({ indexDir, removed, scanned }, 'Swept orphaned session DBs');
  }
  return { scanned, removed };
}
