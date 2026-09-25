/**
 * Whole-family index-DB file handling (TRA-1864).
 *
 * Every SQLite index DB on disk is really a family of files: the base `.db`
 * plus `-wal` / `-shm` companions (WAL mode), a `-journal` (rollback-journal
 * mode), a `.watcher-snapshot` (incremental-discovery resume state, TRA-1714)
 * and a `.holders/` directory (TRA-304 open markers). Several deletion paths
 * historically unlinked only the base `.db` (`remove`, multi-root merge in
 * `add`/`init`, an older ephemeral sweep), so `~/.trace/index/` accumulated
 * ~1.5 GB of stem-less `.db-wal` / `.db-shm` orphans whose stem `.db` was
 * long gone — invisible to every sweep, because each one walks base `.db`
 * files and merely aggregates sidecars.
 *
 * This module is the single place that knows the family:
 * - {@link deleteDbFamily} — delete a whole family for a known base path.
 *   All deletion sites must go through it instead of a bare `unlinkSync`.
 * - {@link findOrphanDbSidecars} / {@link sweepOrphanDbSidecars} — the
 *   one-shot + ongoing migration: sidecars whose stem `.db` no longer exists
 *   are dead by definition (SQLite always creates the main DB file before any
 *   sidecar, so "sidecar without DB" is never a live run mid-startup —
 *   same argument TRA-1714 already applies to stem-less snapshots).
 *
 * Safety: a stem-less sidecar is only deleted when no live holder marker
 * claims its stem (`hasLiveHolderOrUnknown` — a process holding an unlinked
 * DB keeps writing to its WAL through the open handle, and its marker is
 * the only trace of that). An unreadable holder dir reads as "in use".
 */

import fs from 'node:fs';
import path from 'node:path';
import { hasLiveHolderOrUnknown, removeHoldersDir } from '../db-holders.js';
import { EPHEMERAL_INDEX_DIR } from '../global.js';
import { logger } from '../logger.js';
import { INDEX_DIR } from '../shared/paths.js';

/** Every on-disk companion of a `<name>.db` base path, including the base itself. */
export const DB_FAMILY_SUFFIXES = ['', '-wal', '-shm', '-journal', '.watcher-snapshot'] as const;

/** Suffixes that mark a file as a sidecar of some stem `<stem>.db`. */
const ORPHAN_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/**
 * Live SQLite sidecar suffixes (WAL mode `-wal`/`-shm`, rollback-journal
 * `-journal` — including the `<name>.db-journal` spelling, which ends in
 * `-journal` too).
 *
 * TRA-1943: a live DB's sidecars blink in and out of existence as the engine
 * checkpoints — a watcher/indexer that treats them as source races every
 * one (readdir sees `kanban.db-wal`, the engine unlinks it before open, the
 * read dies ENOENT). They are engine scratch, never indexable content, so
 * every indexing entry point drops them before any stat/read via
 * {@link isSqliteSidecarPath}.
 */
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/**
 * Whether a project-relative (or absolute) path is a SQLite sidecar file.
 * Matched on the basename, so a directory that merely happens to end in
 * `-wal` never nukes the real source files inside it.
 */
export function isSqliteSidecarPath(p: string): boolean {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  return SQLITE_SIDECAR_SUFFIXES.some((s) => base.endsWith(s));
}

/** Result of a family delete / orphan sweep. */
export interface DbFamilyDeletion {
  /** Absolute paths actually unlinked. */
  deleted: string[];
  /** Total bytes freed. */
  freedBytes: number;
}

/**
 * Delete a whole DB family: base `.db` + WAL/SHM/journal sidecars +
 * watcher snapshot + holders dir. Missing members are silently skipped;
 * other fs errors are logged, not thrown. Idempotent.
 */
export function deleteDbFamily(basePath: string): DbFamilyDeletion {
  const deleted: string[] = [];
  let freedBytes = 0;
  // Nothing holds a DB that no longer exists (TRA-304).
  removeHoldersDir(basePath);
  for (const suffix of DB_FAMILY_SUFFIXES) {
    const full = basePath + suffix;
    try {
      const stat = fs.statSync(full);
      fs.unlinkSync(full);
      deleted.push(full);
      freedBytes += stat.size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn({ err, file: full }, 'db-family: unlink failed');
      }
    }
  }
  return { deleted, freedBytes };
}

/** One stem-less sidecar group: the missing stem plus the orphans beside it. */
export interface OrphanSidecarGroup {
  /** Absolute stem path (`<dir>/<name>.db`) — does NOT exist on disk. */
  stem: string;
  /** Absolute orphan paths (sidecars + stem-less snapshot, when present). */
  files: string[];
  /** Total bytes the group occupies. */
  bytes: number;
}

function stemForSidecar(dir: string, file: string): string | null {
  for (const suffix of ORPHAN_SIDECAR_SUFFIXES) {
    if (file.endsWith(`.db${suffix}`)) {
      return path.join(dir, file.slice(0, -suffix.length));
    }
  }
  if (file.endsWith('.db.watcher-snapshot')) {
    return path.join(dir, file.slice(0, -'.watcher-snapshot'.length));
  }
  return null;
}

/**
 * List stem-less sidecar groups under the index dirs (read-only).
 *
 * A group is reported only when its stem `.db` is absent AND no live holder
 * claims the stem — i.e. exactly the files {@link sweepOrphanDbSidecars}
 * would delete.
 */
export function findOrphanDbSidecars(
  dirs: string[] = [INDEX_DIR, EPHEMERAL_INDEX_DIR],
): OrphanSidecarGroup[] {
  const stems = new Set<string>();
  for (const dir of new Set(dirs)) {
    // `withFileTypes` Dirents in production; plain strings under `node:fs`
    // mocks in tests (e.g. tests/cli/prune.test.ts) — accept both.
    let entries: Array<fs.Dirent | string>;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }) as unknown as Array<
        fs.Dirent | string
      >;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn({ err, dir }, 'db-family: failed to list dir for orphan scan');
      }
      continue;
    }
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (typeof entry !== 'string' && typeof entry.isFile === 'function' && !entry.isFile()) {
        continue;
      }
      const stem = stemForSidecar(dir, name);
      if (!stem) continue;
      try {
        if (fs.existsSync(stem)) continue; // live DB — its sidecars are normal WAL-mode files
      } catch {
        continue; // unreadable — fail toward "keep it"
      }
      if (!stems.has(stem)) stems.add(stem);
    }
  }

  const groups: OrphanSidecarGroup[] = [];
  for (const stem of stems) {
    // A live holder means some process has this stem open right now (e.g.
    // holding an unlinked DB and still writing its WAL) — never touch it.
    // An unreadable holder dir also vetoes: "I cannot tell" means "keep it".
    if (hasLiveHolderOrUnknown(stem)) continue;
    const files: string[] = [];
    let bytes = 0;
    const candidates = [
      ...ORPHAN_SIDECAR_SUFFIXES.map((s) => `${stem}${s}`),
      `${stem}.watcher-snapshot`,
    ];
    for (const full of candidates) {
      try {
        const stat = fs.statSync(full);
        files.push(full);
        bytes += stat.size;
      } catch {
        /* absent — fine */
      }
    }
    if (files.length > 0) groups.push({ stem, files, bytes });
  }
  // Stable order for logs/tests.
  groups.sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0));
  return groups;
}

/**
 * Delete every stem-less sidecar group under the index dirs. Idempotent.
 * Skips groups whose stem is held open (see {@link findOrphanDbSidecars}).
 */
export function sweepOrphanDbSidecars(
  dirs: string[] = [INDEX_DIR, EPHEMERAL_INDEX_DIR],
): DbFamilyDeletion {
  const deleted: string[] = [];
  let freedBytes = 0;
  for (const group of findOrphanDbSidecars(dirs)) {
    for (const full of group.files) {
      try {
        const stat = fs.statSync(full);
        fs.unlinkSync(full);
        deleted.push(full);
        freedBytes += stat.size;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          logger.warn({ err, file: full }, 'db-family: orphan unlink failed');
        }
      }
    }
    // Drop dead holder markers for a stem that no longer exists; live ones
    // already vetoed this group above.
    removeHoldersDir(group.stem);
  }
  return { deleted, freedBytes };
}
