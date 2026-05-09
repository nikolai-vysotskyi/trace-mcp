/**
 * Best-effort POSIX permissions hardening for trace-mcp's local data store.
 *
 * Decision/index/telemetry/topology DBs accumulate conversation excerpts,
 * file paths, edge metadata, and AI-provider request IDs. On a shared host
 * (CI worker, multi-user dev box) these should not be world-readable.
 *
 * - `restrictHomeDirPerms()` chmods `~/.trace-mcp` (and any nested data dir)
 *   to `0700`, applied once on first opener.
 * - `restrictDbPerms()` chmods a SQLite DB file plus its `*-wal` / `*-shm`
 *   sidecars to `0600`. Sidecars come and go with WAL activity, so callers
 *   may want to invoke this after a write burst as well — but the parent
 *   directory at `0700` already prevents access even without the per-file
 *   bit being current.
 *
 * No-op on Windows, where POSIX mode bits don't apply (the equivalent
 * protection there is the per-user AppData ACL).
 */

import fs from 'node:fs';

export function restrictDbPerms(dbPath: string): void {
  if (process.platform === 'win32') return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = dbPath + suffix;
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // File doesn't exist (no WAL yet) or chmod failed (mounted FS, root-owned).
      // Best-effort — defense in depth, parent directory mode is the real guard.
    }
  }
}

export function restrictHomeDirPerms(homeDir: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(homeDir, 0o700);
  } catch {
    /* may not exist yet, or not ours — caller has already mkdir'd it */
  }
}
