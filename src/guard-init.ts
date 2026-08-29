/**
 * Guard onboarding state for a project.
 *
 * The guard hook reads `<projectRoot>/.trace-mcp/guard-mode` before each tool
 * call and falls back to `strict` when it is absent. New projects are supposed
 * to get a 7-day `coach` grace period instead — that contract used to be armed
 * only by the desktop app (TRA-341), so a project you never opened in the app
 * landed straight in strict.
 *
 * Arming it at registration means every project the CLI or daemon picks up
 * gets the grace period, app or no app. The desktop app keeps its own copy of
 * this logic in `packages/app/src/main/guard-control.ts` (separate build, no
 * shared module between the two packages); both are idempotent and write the
 * same two files, so whichever runs first wins and the other no-ops.
 */

import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_LOCAL_DIRNAME } from './shared/paths.js';

export function guardModeFile(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_LOCAL_DIRNAME, 'guard-mode');
}

export function guardInstallDateFile(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_LOCAL_DIRNAME, 'install-date');
}

/**
 * Arm the coach grace period for a project on first encounter.
 *
 * Idempotent: no-ops when the mode file already exists, so calling it from
 * more than one entry point is safe. Best-effort — a read-only or otherwise
 * unwritable project root must not fail registration, it just means the guard
 * defaults to strict there.
 *
 * Returns true iff this call armed the grace period.
 */
export function initializeGuard(projectRoot: string): boolean {
  const modeFile = guardModeFile(projectRoot);
  const dateFile = guardInstallDateFile(projectRoot);
  // Exclusive create rather than existsSync-then-write: the check-then-use
  // shape is a TOCTOU race (CodeQL js/file-system-race), and EEXIST answers
  // "already initialized" atomically. An unwritable root fails the same way
  // and is equally a no-op.
  try {
    fs.mkdirSync(path.dirname(modeFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(modeFile, 'coach\n', { flag: 'wx', mode: 0o600 });
  } catch {
    return false;
  }
  try {
    fs.writeFileSync(dateFile, `${Math.floor(Date.now() / 1000)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    /* a leftover install-date keeps its original expiry — that is the safe direction */
  }
  return true;
}
