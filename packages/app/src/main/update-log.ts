/**
 * The update audit log: `<CLI state dir>/update.log`.
 *
 * Every `apply-update` attempt records command, exit code, full stdout/stderr.
 * The renderer only sees a short summary, so this log is the place to look when
 * a user reports "Update failed".
 *
 * Lives in its own module rather than in index.ts so the rotation ceiling can be
 * tested without booting the Electron main process (TRA-707).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getLauncherDir } from './trace-home';

// TRA-702: update.log had no rotation and only ever grew. Every entry carries
// a full stdout/stderr capture, so a few failing updates move it by megabytes.
// One generation is enough for the "user reports 'Update failed'" case this log
// exists to serve — nobody reads the run before last.
export const UPDATE_LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Resolved per call, not once at import: the CLI can rename ~/.trace-mcp to
 * ~/.trace (TRA-611) while this app is running, and a cached path would keep
 * recreating the directory the rename just removed.
 */
export function updateLogPath(): string {
  return path.join(getLauncherDir(), 'update.log');
}

export function appendUpdateLog(entry: Record<string, unknown>): void {
  try {
    const target = updateLogPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      if (fs.statSync(target).size > UPDATE_LOG_MAX_BYTES) {
        fs.renameSync(target, `${target}.1`);
      }
    } catch {
      /* no log yet, or rotation raced another writer — append regardless */
    }
    fs.appendFileSync(
      target,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch {
    /* logging must never break the update */
  }
}
