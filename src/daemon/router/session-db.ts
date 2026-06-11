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

/**
 * Seed a fresh session DB from the canonical project DB using SQLite's
 * online backup API (safe against a daemon writing concurrently). Returns
 * true when the session DB was seeded; false means "start from scratch"
 * (no shared DB yet, or the copy failed — any partial file is removed).
 */
export async function seedSessionDbFromShared(
  sharedDbPath: string,
  sessionDbPath: string,
): Promise<boolean> {
  if (!fs.existsSync(sharedDbPath)) return false;
  let src: Database.Database | null = null;
  try {
    src = new Database(sharedDbPath, { readonly: true, fileMustExist: true });
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
 * Delete orphaned session DBs in `indexDir`. A session DB is an orphan when
 * its `server_state.pid` points at a dead process; when the owner cannot be
 * read at all, fall back to an age check. Live sessions are never touched.
 * Best-effort: every failure skips the file rather than throwing.
 */
export function sweepOrphanedSessionDbs(indexDir: string): { scanned: number; removed: number } {
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
