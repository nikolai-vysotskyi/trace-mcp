/**
 * Persistent state and pure decisions for the in-app updater.
 *
 * The Electron app has two update channels:
 *   1. **Zip-staged** — npm postinstall drops a verified zip into
 *      ~/Applications/.trace-mcp-pending.zip; a helper swaps the .app
 *      bundle on restart. Detected via `hasPendingUpdate()` in index.ts.
 *   2. **npm-only** — `apply-update` runs `npm install -g trace-mcp@latest`
 *      which only updates the CLI/MCP server on disk. The Electron bundle
 *      stays at whatever `app.getVersion()` reports.
 *
 * Before this module, `apply-update` returned `pending: true` whenever
 * the on-disk npm package was newer than the running Electron process —
 * even when no zip was staged. The UI then showed "Restart to install",
 * the user restarted, the bundle had not been swapped, `check-for-update`
 * saw the same mismatch, and the prompt returned. The cycle.
 *
 * Two pure decisions break the cycle:
 *
 *   - `computeUpdateOutcome` is the source of truth for what just
 *     happened. The IPC handler returns `pending: true` only for
 *     "bundle-pending"; "npm-only" is honest about the half-update.
 *
 *   - `isStuckOnVersion` reads the persisted "I last npm-installed X
 *     while bundled at Y" marker. While the latest npm version equals
 *     the stuck target and the bundle has not moved, `check-for-update`
 *     suppresses the banner so the user is not asked to do something
 *     they have already done. A real new release breaks the marker
 *     automatically: `cmpSemver(latest, stuck.target) > 0` falsifies it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface NpmOnlyAttempt {
  /** `app.getVersion()` at the time of the attempt — the bundle that stayed put. */
  bundle: string;
  /** Version that landed in the global npm package directory. */
  target: string;
  /** Epoch ms — diagnostic only, not used in decisions. */
  at: number;
}

export interface AppUpdateState {
  lastNpmOnlyAttempt?: NpmOnlyAttempt;
}

export type UpdateOutcome = 'bundle-pending' | 'npm-only' | 'already-current';

export const APP_UPDATE_STATE_PATH = path.join(
  os.homedir(),
  '.trace-mcp',
  'app-update-state.json',
);

/**
 * Reads the persisted state. Returns an empty object on any failure
 * (file missing, malformed JSON, permission error). Persistence is
 * best-effort: a missing file just means the user gets the banner once
 * more, which is far better than crashing the updater on disk hiccups.
 */
export function readAppUpdateState(
  filePath: string = APP_UPDATE_STATE_PATH,
): AppUpdateState {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as AppUpdateState;
  } catch {
    /* fall through */
  }
  return {};
}

/** Writes the state. Failures are swallowed for the same best-effort reasons. */
export function writeAppUpdateState(
  next: AppUpdateState,
  filePath: string = APP_UPDATE_STATE_PATH,
): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  } catch {
    /* persistence is best-effort */
  }
}

/**
 * Decide what `apply-update` should report based on observable facts:
 * the version that landed in the npm package directory, the version
 * currently running inside Electron, and whether the legacy zip-staged
 * path placed a swap-ready bundle on disk.
 *
 * `cmpSemver` is injected so the helper stays pure and testable without
 * pulling the Electron-side helper into a test bundle.
 */
export function computeUpdateOutcome(
  installedVersion: string | undefined,
  runningVersion: string,
  hasPendingZip: boolean,
  cmpSemver: (a: string, b: string) => number,
): UpdateOutcome {
  if (hasPendingZip) return 'bundle-pending';
  if (installedVersion && cmpSemver(installedVersion, runningVersion) > 0) {
    return 'npm-only';
  }
  return 'already-current';
}

/**
 * Returns true when the user previously hit the npm-only outcome for
 * exactly this `(bundle, latest)` pair and nothing has moved since.
 * In that state, `check-for-update` should report `available: false`
 * with a sticky flag: there is nothing further the in-app flow can do.
 *
 * The marker auto-clears the moment the registry advances past
 * `stuck.target` (a genuinely new release appears) or the bundle moves
 * (the user manually reinstalled the .app).
 */
export function isStuckOnVersion(
  currentBundle: string,
  latestNpm: string,
  state: AppUpdateState,
  cmpSemver: (a: string, b: string) => number,
): boolean {
  const stuck = state.lastNpmOnlyAttempt;
  if (!stuck) return false;
  return (
    cmpSemver(currentBundle, stuck.bundle) === 0 &&
    cmpSemver(latestNpm, stuck.target) <= 0
  );
}
