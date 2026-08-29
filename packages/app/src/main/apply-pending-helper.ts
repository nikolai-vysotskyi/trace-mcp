// Pure (no `electron` import) helper for the staged-update-swap flow, kept
// separate from main/index.ts so it can be unit tested without booting
// Electron. See main/index.ts for how `restart-app` and `before-quit` use it.

import { spawn } from 'child_process';
import fs from 'fs';
import type { UpdateChannel } from './update-channel';

export interface PendingUpdatePaths {
  pendingZip: string;
  pendingVersion: string;
}

export interface ApplyHelperPaths extends PendingUpdatePaths {
  applyHelper: string;
}

/** True when a verified update zip is staged and waiting to be applied. */
export function hasPendingUpdate(paths: PendingUpdatePaths): boolean {
  try {
    return fs.existsSync(paths.pendingZip) && fs.existsSync(paths.pendingVersion);
  } catch {
    return false;
  }
}

/**
 * Spawn the detached helper that swaps the staged bundle once `pid` exits,
 * then relaunches the new app. Returns true if the helper was spawned —
 * callers must not fall through to a plain relaunch/quit in that case, since
 * the helper now owns finishing the exit.
 *
 * `channel` is the hard interlock against the Windows electron-updater path:
 * only `zip-staged` may swap a bundle this way, so the two mechanisms can
 * never both fire on one platform.
 */
export function trySpawnApplyHelper(
  paths: ApplyHelperPaths,
  pid: number,
  channel: UpdateChannel,
): boolean {
  if (channel !== 'zip-staged') return false;
  if (!hasPendingUpdate(paths) || !fs.existsSync(paths.applyHelper)) return false;
  try {
    const child = spawn(process.execPath, [paths.applyHelper, String(pid)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    console.error(`[trace-mcp] spawned apply-pending-update helper pid=${child.pid}`);
    return true;
  } catch (err) {
    console.error(`[trace-mcp] spawn apply-pending-update failed:`, err);
    return false;
  }
}
