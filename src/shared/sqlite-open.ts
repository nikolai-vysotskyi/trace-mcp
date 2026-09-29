/**
 * Safe SQLite open with stale-WAL recovery (TRA-2068).
 *
 * Background: TRA-1233 (11520b4) unlinked a 0-byte `<db>-wal` in the
 * `DecisionStore` / `TopologyStore` constructors *before* opening the DB.
 * A 0-byte WAL is the normal state of a live WAL database right after a
 * `TRUNCATE` checkpoint, so a second opener unlinked the WAL from under
 * live connections. The live processes kept appending to the unlinked
 * inode while the new process created a fresh WAL file — divergent WALs
 * for one DB, ending in `database disk image is malformed` (GH#1445).
 *
 * This module is the only place allowed to delete a WAL on the open path,
 * and it does so only when the WAL is provably stale:
 *
 * 1. The open itself must have failed with `SQLITE_IOERR_SHORT_READ`
 *    (live 0-byte WALs open fine — no error, no healing, no unlink).
 * 2. The WAL must still be exactly 0 bytes when re-checked.
 * 3. No `-shm` companion may exist. A WAL-mode DB held open by any live
 *    connection has a `-shm` file, and a crashed writer normally leaves a
 *    stale one behind (SQLite only removes `-shm` on a clean last-close) —
 *    so this gate admits only a 0-byte WAL whose `-shm` is genuinely gone
 *    (clean-close leftover replaced externally, unlinked remnant). Anything
 *    with a `-shm`, live or crashed, is refused: we rethrow instead of
 *    touching the WAL — failing safe (a visible open error) beats risking
 *    a malformed database.
 *
 * After a successful heal there is exactly one retry. Anything else —
 * readonly opens included — rethrows the original error.
 */

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { logger } from '../logger.js';

/** Whether an open failure is the short-WAL-header read error. */
export function isSqliteShortReadError(err: unknown): boolean {
  const code = err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? '') : '';
  const message = err instanceof Error ? err.message : String(err);
  return /SHORT_READ/i.test(`${code} ${message}`);
}

/**
 * Remove a 0-byte WAL only when it is provably stale (see module doc).
 * Returns true when the caller should retry the open once (WAL removed,
 * or already gone — lost race with another healer); false when there is
 * nothing safe to heal (caller rethrows the original error).
 */
function removeProvablyStaleZeroByteWal(dbPath: string): boolean {
  const walPath = `${dbPath}-wal`;
  let size: number;
  try {
    size = fs.statSync(walPath).size;
  } catch {
    return false; // WAL already gone — nothing to heal.
  }
  if (size !== 0) return false; // Non-empty WAL: real content, never touch.
  if (fs.existsSync(`${dbPath}-shm`)) {
    // A live connection may hold this WAL open (0 bytes is its normal
    // post-checkpoint state). Refuse — see GH#1445.
    logger.warn(
      { dbPath },
      'sqlite-open: 0-byte WAL with a live -shm companion; refusing to unlink (GH#1445)',
    );
    return false;
  }
  try {
    fs.unlinkSync(walPath);
  } catch {
    // Lost a race with another healer (or a concurrent opener): only treat
    // "already gone" as healed and retry; anything still on disk rethrows.
    return !fs.existsSync(walPath);
  }
  logger.warn({ dbPath }, 'sqlite-open: removed stale 0-byte WAL left by a dead process');
  return true;
}

/**
 * Open a SQLite DB, recovering from a stale 0-byte WAL left behind by a
 * dead process. Never unlinks a WAL that could belong to a live
 * connection. Readonly opens never heal (rethrow immediately).
 *
 * better-sqlite3 opens lazily, so the first touch (`journal_mode = WAL`
 * for writable opens) is inside the guarded region too — that is where a
 * strict SQLite build reports the short WAL header (TRA-1233), not in the
 * constructor. Half-open handles are closed before healing (no fd leak).
 */
export function openDatabaseWithWalRecovery(
  dbPath: string,
  opts?: { readonly?: boolean },
): Database.Database {
  const readonly = opts?.readonly ?? false;
  const openOnce = (): Database.Database => {
    const db = new Database(dbPath, { readonly });
    try {
      if (!readonly) {
        db.pragma('journal_mode = WAL');
      }
      return db;
    } catch (err) {
      try {
        db.close();
      } catch {
        /* best-effort: never leak the half-open handle */
      }
      throw err;
    }
  };
  try {
    return openOnce();
  } catch (err) {
    if (readonly || !isSqliteShortReadError(err) || !removeProvablyStaleZeroByteWal(dbPath)) {
      throw err;
    }
    // Single retry after the heal; its error (if any) propagates to the
    // caller, whose constructor try/catch closes the handle (no leak).
    return openOnce();
  }
}
