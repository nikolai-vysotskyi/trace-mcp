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
  /** Consecutive npm-only outcomes for this bundle — diagnostic only. */
  attempts?: number;
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

/** A global npm root that currently holds a `trace-mcp` install. */
export interface GlobalInstall {
  /** The `.../lib/node_modules` directory. */
  root: string;
  /** Version read from `<root>/trace-mcp/package.json`. */
  version: string;
}

/**
 * Read the trace-mcp version out of each candidate global npm root.
 *
 * A developer machine routinely has several: nvm, a bundled runtime (Herd,
 * Hermes), Homebrew node, a system node. `npm install -g` only ever writes
 * into the root owned by the npm binary that ran it, so every other root
 * freezes at whatever version it last received — silently, because the
 * install that did happen reports success.
 *
 * Roots are deduplicated by the realpath of the package directory, so a
 * symlink farm (`npm link`, a shared prefix behind two PATH entries) counts
 * once. Unreadable or absent roots are skipped, not reported.
 */
export function scanGlobalInstalls(roots: readonly (string | null | undefined)[]): GlobalInstall[] {
  const seen = new Set<string>();
  const found: GlobalInstall[] = [];
  for (const root of roots) {
    if (!root) continue;
    let pkgDir: string;
    try {
      pkgDir = fs.realpathSync(path.join(root, 'trace-mcp'));
    } catch {
      continue; // Root absent, or no trace-mcp in it.
    }
    if (seen.has(pkgDir)) continue;
    seen.add(pkgDir);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')) as {
        version?: unknown;
      };
      const version = String(pkg.version ?? '').replace(/^v/, '');
      if (version) found.push({ root, version });
    } catch {
      /* half-extracted or unreadable package — not a version we can report on */
    }
  }
  return found;
}

/**
 * Roots left behind the newest install on this machine.
 *
 * We report rather than repair: writing into a global root the user never
 * pointed us at is a meaningful escalation of what an update click may do.
 * But an unfixable state must at least not look healthy — a consumer wired
 * to a stale root runs old code while every other signal says "up to date".
 */
export function findStaleRoots(
  installs: readonly GlobalInstall[],
  cmpSemver: (a: string, b: string) => number,
): GlobalInstall[] {
  if (installs.length < 2) return [];
  const newest = installs.reduce((a, b) => (cmpSemver(b.version, a.version) > 0 ? b : a));
  return installs.filter((i) => cmpSemver(i.version, newest.version) < 0);
}

export const LAUNCHER_ENV_PATH = path.join(
  process.env.TRACE_MCP_HOME?.trim() || path.join(os.homedir(), '.trace-mcp'),
  'launcher.env',
);

/**
 * The CLI path the launcher shim hands to MCP clients, or null if `trace-mcp
 * init` has never run.
 *
 * `trace-mcp init` writes `TRACE_MCP_CLI` into launcher.env, and every client
 * registration points at the shim rather than at a version-specific bin — so
 * this file, not `$PATH`, is the honest answer to "which install is actually
 * being run". A GUI-launched Electron inherits PATH from launchd, not from the
 * user's shell, so PATH could not answer it here even if we asked.
 */
export function readLauncherCliPath(launcherEnv: string = LAUNCHER_ENV_PATH): string | null {
  try {
    // Same whitelist-and-unquote rules as src/init/launcher.ts readLauncherConfig().
    for (const line of fs.readFileSync(launcherEnv, 'utf-8').split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq <= 0 || line.trimStart().startsWith('#')) continue;
      if (line.slice(0, eq).trim() !== 'TRACE_MCP_CLI') continue;
      let value = line.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1);
      }
      return value || null;
    }
  } catch {
    /* never initialised, or unreadable — we simply do not know */
  }
  return null;
}

/**
 * The one stale root worth telling the user about: the one MCP clients run.
 *
 * A second global root sitting on an old version is normally inert — nothing
 * resolves to it, so nothing runs the old code. Reporting it (TRA-364) warned
 * about a fact rather than a consequence, and the user had no way to tell which
 * of the two it was (TRA-377). It only costs the user something when the
 * launcher shim points into it, and then it costs them a lot: every editor gets
 * the old server while the app says it is current. So we report exactly that
 * case and stay quiet otherwise.
 */
export function staleRootInUse(
  staleRoots: readonly GlobalInstall[],
  cliPath: string | null,
): GlobalInstall | null {
  if (!cliPath) return null;
  let cli: string;
  try {
    cli = fs.realpathSync(cliPath);
  } catch {
    return null;
  }
  for (const stale of staleRoots) {
    try {
      const pkgDir = fs.realpathSync(path.join(stale.root, 'trace-mcp'));
      if (cli === pkgDir || cli.startsWith(pkgDir + path.sep)) return stale;
    } catch {
      /* root vanished since the scan */
    }
  }
  return null;
}

/**
 * Should we try to stage the bundle swap ourselves?
 *
 * Yes exactly when the package on disk is ahead of the running bundle and
 * nothing is staged yet — the state five consecutive updates left one user in,
 * with no retry, no warning and no telemetry (TRA-357). A staged zip means the
 * swap is already waiting for a restart, so there is nothing to repair.
 */
export function shouldAttemptRepair(
  installedVersion: string | undefined,
  runningVersion: string,
  hasPendingZip: boolean,
  cmpSemver: (a: string, b: string) => number,
): boolean {
  if (hasPendingZip) return false;
  if (!installedVersion) return false;
  return cmpSemver(installedVersion, runningVersion) > 0;
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
