/**
 * Global-install inspection for the app's update surface.
 *
 * `npm install -g` only ever writes into the global root its own npm binary
 * owns, so a machine with several (nvm, Herd, Homebrew, system node) keeps
 * every other root frozen at whatever version it last received — silently,
 * because the install that did happen reports success. These helpers find that
 * state and narrow it to the one root the user actually pays for.
 *
 * Everything else that used to live here — the persisted "I last npm-installed
 * X while bundled at Y" marker, the stuck-on-version suppression, the
 * bundle-pending / npm-only outcome split, the on-disk bundle version — existed
 * only because the macOS staged-zip updater could half-update a machine.
 * macOS is on electron-updater now, so there is no half-update to remember and
 * no state to persist (TRA-437).
 */

import fs from 'node:fs';
import path from 'node:path';
import { isPlausibleInstallPath } from './install-path';
import { getLauncherDir } from './trace-home';

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

export const LAUNCHER_ENV_PATH = path.join(getLauncherDir(), 'launcher.env');

/**
 * The CLI path the launcher shim hands to MCP clients, or null if `trace-mcp
 * init` has never run.
 *
 * init writes `TRACE_CLI` — or `TRACE_MCP_CLI`, before the TRA-610 rename —
 * into launcher.env, and every client
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
      const key = line.slice(0, eq).trim();
      if (key !== 'TRACE_CLI' && key !== 'TRACE_MCP_CLI') continue;
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

// --- Installed .app bundles --------------------------------------------------
//
// The same shape one layer up from the npm roots above: electron-updater updates
// the bundle it is *running from*, so a machine carrying two installed copies
// (`/Applications` and `~/Applications`, the second dragged in later) keeps the
// other frozen at whatever version it arrived at — and whichever copy launches
// next decides the version the user gets. `app-location.json` records one
// location and validates it (TRA-357); a second plausible bundle elsewhere is
// invisible to every check we have (TRA-692).

/** The bundle filename we install under. Mirrors `scripts/locate-app.mjs`. */
export const APP_BUNDLE_NAME = 'trace-mcp.app';

/** An installed `trace-mcp.app` found on disk. */
export interface AppBundle {
  /** Absolute path to the `.app` bundle. */
  path: string;
  /** `CFBundleShortVersionString`, without a leading `v`. */
  version: string;
  /** True for the bundle this process is running from. */
  running: boolean;
}

/**
 * The version a bundle claims, from `Contents/Info.plist`.
 *
 * Mirrors `readBundleVersion` in `scripts/locate-app.mjs` — same regex over the
 * XML plist, no `PlistBuddy` subprocess. The plist is the only honest answer to
 * "what is installed here": sidecar markers record what a swap intended and part
 * company with the bundle whenever one is replaced out-of-band (TRA-443).
 */
export function readBundleVersion(appPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf-8');
    const m = raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m?.[1]?.trim().replace(/^v/, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `.app` bundle an Electron main process runs from, or null when it does not
 * run out of one (`electron .` during development, Windows, Linux).
 */
export function runningAppBundle(execPath: string): string | null {
  const marker = `.app${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const at = execPath.indexOf(marker);
  return at < 0 ? null : execPath.slice(0, at + '.app'.length);
}

/** The bundle path `app-location.json` records, or null. */
export function readAppLocationMarker(
  markerPath: string = path.join(getLauncherDir(), 'app-location.json'),
): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as { appPath?: unknown };
    return typeof parsed.appPath === 'string' ? parsed.appPath : null;
  } catch {
    return null;
  }
}

/**
 * Every installed bundle among `candidates`, with the running one marked.
 *
 * Deduplicated by realpath, so a path reached twice (the marker and the
 * conventional directory it already names) counts once. Build outputs are
 * skipped by the same gate the location marker uses — a bundle inside a checkout
 * is not an install and must not raise a duplicate warning on a dev machine.
 */
export function scanAppBundles(
  candidates: readonly (string | null | undefined)[],
  runningPath: string | null,
): AppBundle[] {
  let running: string | null = null;
  if (runningPath) {
    try {
      running = fs.realpathSync(runningPath);
    } catch {
      running = runningPath;
    }
  }
  const seen = new Set<string>();
  const found: AppBundle[] = [];
  for (const candidate of candidates) {
    if (!candidate || !isPlausibleInstallPath(candidate)) continue;
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue; // Nothing at that path.
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const version = readBundleVersion(candidate);
    if (!version) continue; // Not one of ours, or half-swapped.
    found.push({ path: candidate, version, running: real === running });
  }
  return found;
}
