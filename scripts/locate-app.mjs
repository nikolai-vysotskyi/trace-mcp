#!/usr/bin/env node

/**
 * Single source of truth for "where is the installed trace-mcp.app".
 *
 * Three callers historically computed this independently and all hard-coded
 * `~/Applications`:
 *   - scripts/postinstall-app.mjs       (zip-stage on npm install)
 *   - scripts/apply-pending-update.mjs  (bundle swap on restart)
 *   - packages/app/src/main/index.ts    (Electron-side update IPC)
 *
 * When the user drag-installed the .app into `/Applications` (system-wide)
 * — the more common location on macOS — every path missed it, the postinstall
 * exited silently without staging, the in-app updater shipped a npm-only
 * update, and the "Restart to install" banner cycled forever.
 *
 * Resolution chain (highest-confidence first):
 *
 *   1. **Marker file** `~/.trace/app-location.json` (`~/.trace-mcp` on a
 *      machine the CLI has not renamed yet), written by Electron
 *      main on every startup from `process.execPath`. This is exact: the path
 *      came from the running bundle itself, not from a guess about install
 *      conventions. The marker is the steady-state mechanism after the first
 *      successful upgrade past this change.
 *
 *   2. **`mdfind` by `CFBundleIdentifier`**. Spotlight's Launch Services index
 *      knows every installed .app regardless of install location, so this
 *      finds the bundle on a *first* run before the marker exists. Used to
 *      bootstrap users currently stuck on a pre-marker version of the .app.
 *
 *   3. **Conventional fallback directories** `~/Applications` then
 *      `/Applications`. Last-resort for environments where Spotlight is
 *      disabled (rare, corporate MDM territory). Logged as `fallback` so
 *      diagnostic queries can spot the degraded mode.
 *
 * Validation: every candidate path is checked for `Contents/Info.plist` with
 * a matching `CFBundleIdentifier`, so a stale Spotlight entry or a
 * leftover-marker pointing at a moved bundle is rejected and the chain
 * continues. A path that fails validation is never returned.
 *
 * Returns `null` on non-darwin platforms or when nothing is found — callers
 * are expected to no-op in that case (matches prior `process.exit(0)`
 * behavior of postinstall-app.mjs when the .app was absent).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { traceHomeDir } from './trace-home.mjs';

export const APP_NAME = 'trace-mcp.app';
export const BUNDLE_ID = 'com.trace-mcp.app';
export const LOCATION_MARKER_FILENAME = 'app-location.json';

/**
 * Path segments that never appear in an *installed* bundle's location but
 * always appear in a build output tree. `release/mac-arm64/trace-mcp.app` is
 * what electron-builder emits, and such a bundle is packaged — `Info.plist`
 * carries the right bundle id, so plist validation alone accepts it.
 *
 * Keep in sync with `packages/app/src/main/install-path.ts`; the two copies
 * exist because Electron main is compiled with `rootDir: src/main` and cannot
 * import this file. `install-path.test.ts` fails if they diverge.
 */
const IMPLAUSIBLE_SEGMENTS = new Set([
  'node_modules',
  'release',
  'dist',
  'out',
  'build',
  'target',
  'packages',
  'src',
  'workdir',
  'DerivedData',
  '.git',
]);

/**
 * True when `appPath` could plausibly be an *installed* app rather than a
 * local build. A bundle produced by `electron-builder` inside a checkout
 * validates as a real bundle in every other respect, so once it got recorded
 * in the location marker every later `npm install -g` "updated" a throwaway
 * directory and the user's real install froze forever (TRA-357).
 *
 * Two signals, both cheap: a build-tree segment anywhere in the parent path,
 * or a `.git` directory in any near ancestor (a repository checkout).
 *
 * @param {string} appPath
 * @returns {boolean}
 */
export function isPlausibleInstallPath(appPath) {
  if (!appPath || !path.isAbsolute(appPath)) return false;
  const parent = path.dirname(appPath);
  for (const segment of parent.split(path.sep)) {
    if (IMPLAUSIBLE_SEGMENTS.has(segment)) return false;
  }
  let dir = parent;
  for (let i = 0; i < 6 && dir && dir !== path.dirname(dir); i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return false;
    } catch {
      /* unreadable ancestor — treat as plausible, validation continues */
    }
    dir = path.dirname(dir);
  }
  return true;
}

/**
 * The version the bundle itself claims, read from `Contents/Info.plist`.
 *
 * This is the only honest answer to "what is installed". The sibling
 * `.trace-mcp-version` file records what the last swap *intended*, and the two
 * part company whenever a bundle is replaced out-of-band — a hand-dragged
 * older `.app`, a restore from a backup. Callers that gate on the marker alone
 * then see "already up to date" forever (TRA-443).
 *
 * @param {string} appPath
 * @returns {string | undefined} Version without a leading `v`, or undefined
 *   when the plist cannot be read.
 */
export function readBundleVersion(appPath) {
  try {
    const raw = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf-8');
    const m = raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m?.[1]?.trim().replace(/^v/, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * @typedef {Object} LocateResult
 * @property {string} appPath - Absolute path to the validated `.app` bundle.
 * @property {'marker'|'mdfind'|'fallback'} source - Which step of the chain resolved it.
 */

/**
 * @typedef {Object} LocateOptions
 * @property {string} [homeDir]      Override `os.homedir()` (tests).
 * @property {string} [appName]      Bundle filename, default `trace-mcp.app`.
 * @property {string} [bundleId]     Expected `CFBundleIdentifier`.
 * @property {string} [mdfindBin]    Path to `mdfind`, default `/usr/bin/mdfind`.
 * @property {string} [plistBuddyBin] Path to `PlistBuddy`, default Apple's location.
 * @property {string[]} [fallbackDirs] Conventional directories to probe last.
 * @property {string}  [platform]    Override `process.platform` (tests).
 */

/**
 * @param {LocateOptions} [options]
 * @returns {LocateResult | null}
 */
export function locateInstalledApp(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return null;

  const home = options.homeDir ?? os.homedir();
  const appName = options.appName ?? APP_NAME;
  const bundleId = options.bundleId ?? BUNDLE_ID;
  const mdfindBin = options.mdfindBin ?? '/usr/bin/mdfind';
  const plistBuddyBin = options.plistBuddyBin ?? '/usr/libexec/PlistBuddy';
  const fallbackDirs = options.fallbackDirs ?? [path.join(home, 'Applications'), '/Applications'];
  const markerPath = path.join(traceHomeDir(options.homeDir), LOCATION_MARKER_FILENAME);

  const fromMarker = resolveFromMarker(markerPath, bundleId, plistBuddyBin);
  if (fromMarker) return { appPath: fromMarker, source: 'marker' };

  const fromMdfind = resolveFromMdfind(mdfindBin, bundleId, plistBuddyBin);
  if (fromMdfind) return { appPath: fromMdfind, source: 'mdfind' };

  for (const dir of fallbackDirs) {
    const candidate = path.join(dir, appName);
    if (isValidAppBundle(candidate, bundleId, plistBuddyBin)) {
      return { appPath: candidate, source: 'fallback' };
    }
  }

  return null;
}

/**
 * True when `appPath` is a real installed bundle of ours: a plausible install
 * location (not a build tree) holding an `Info.plist` with our bundle id.
 *
 * `locateInstalledApp()` answers "which one bundle do we act on"; this answers
 * "is this particular path one of ours", which is what a caller sweeping every
 * conventional directory needs. A machine can hold more than one installed
 * copy, and updating only the resolved one leaves the others frozen at
 * whatever version they were dragged in at, forever.
 *
 * @param {string} appPath
 * @param {LocateOptions} [options]
 * @returns {boolean}
 */
export function isInstalledApp(appPath, options = {}) {
  if (!isPlausibleInstallPath(appPath)) return false;
  return isValidAppBundle(
    appPath,
    options.bundleId ?? BUNDLE_ID,
    options.plistBuddyBin ?? '/usr/libexec/PlistBuddy',
  );
}

/**
 * The `.app` bundle a running trace-mcp process was launched from, or null.
 *
 * A machine can hold more than one installed bundle — dragged into
 * `/Applications` once, re-installed into `~/Applications` later — and the two
 * updaters then disagree about which one "the install" is: `postinstall-app.mjs`
 * asks `locateInstalledApp()` (marker first), while Electron main derives its
 * install dir from `process.execPath`. When they diverge, postinstall stages
 * `.trace-mcp-pending.zip` next to a bundle nobody is running, the running copy
 * never sees a pending update, and it stays behind forever while every
 * `npm install -g` reports success — the TRA-357 shape one level up, observed
 * with a 112 MB orphan zip beside a `/Applications` bundle two releases behind.
 *
 * The running bundle is the only copy the user can actually observe, so it is
 * the honest target. `pgrep -f` alone cannot answer this — it matches on the
 * bundle-relative path and returns pids, not paths — so we resolve each pid's
 * executable through `ps -o comm=` and walk back up to the `.app`.
 *
 * Same two gates as every other resolver here: a build-tree path never counts
 * as an install, and the bundle id must match.
 *
 * @param {LocateOptions & { pgrepBin?: string, psBin?: string }} [options]
 * @returns {string | null}
 */
export function runningBundlePath(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return null;

  const appName = options.appName ?? APP_NAME;
  const bundleId = options.bundleId ?? BUNDLE_ID;
  const pgrepBin = options.pgrepBin ?? '/usr/bin/pgrep';
  const psBin = options.psBin ?? '/bin/ps';
  const plistBuddyBin = options.plistBuddyBin ?? '/usr/libexec/PlistBuddy';
  const marker = `${appName}${path.sep}Contents${path.sep}MacOS${path.sep}`;

  let pids;
  try {
    pids = execFileSync(pgrepBin, ['-f', marker], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 5_000,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line));
  } catch {
    // Non-zero exit is pgrep's "no match" — indistinguishable from a failure
    // here, and both mean the same thing to callers: no running bundle.
    return null;
  }

  for (const pid of pids) {
    let comm;
    try {
      comm = execFileSync(psBin, ['-p', pid, '-o', 'comm='], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
        timeout: 5_000,
      }).trim();
    } catch {
      continue;
    }
    const at = comm.indexOf(marker);
    if (at === -1) continue;
    const candidate = comm.slice(0, at + appName.length);
    if (!isPlausibleInstallPath(candidate)) continue;
    if (!isValidAppBundle(candidate, bundleId, plistBuddyBin)) continue;
    return candidate;
  }
  return null;
}

/**
 * Repair an update swap that died halfway through.
 *
 * Both swap sites (`postinstall-app.mjs` and `apply-pending-update.mjs`) do:
 *
 *     rename(trace-mcp.app -> trace-mcp.app.bak-<pid>)   <-- crash window
 *     rename(<staged>      -> trace-mcp.app)
 *     rm -rf trace-mcp.app.bak-<pid>                     <-- crash window
 *
 * A reboot, SIGKILL or power loss inside the first window leaves the user with
 * NO bundle at all — only `trace-mcp.app.bak-<pid>`, which macOS treats as a
 * plain folder. `locateInstalledApp()` then returns null forever, so both
 * scripts abort at their first gate and nothing ever retries: the install is
 * bricked until the user reinstalls by hand. A crash inside the second window
 * leaks a full Electron bundle (hundreds of MB) that nothing cleans up.
 *
 * This scans the directories we could have swapped in and settles both cases:
 * restore the backup when the live bundle is missing, delete it when it is
 * not. Only `<appName>.bak-<digits>` is touched — that name is written by us
 * and by nothing else.
 *
 * Best-effort by design: every filesystem error is swallowed, exactly like the
 * callers that invoke it.
 *
 * @param {LocateOptions} [options]
 * @returns {Array<{ action: 'restored' | 'reclaimed', path: string }>}
 */
export function recoverInterruptedSwap(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return [];

  const home = options.homeDir ?? os.homedir();
  const appName = options.appName ?? APP_NAME;
  const bundleId = options.bundleId ?? BUNDLE_ID;
  const plistBuddyBin = options.plistBuddyBin ?? '/usr/libexec/PlistBuddy';
  const fallbackDirs = options.fallbackDirs ?? [path.join(home, 'Applications'), '/Applications'];

  // The marker's directory is where a drag-installed bundle actually lives, so
  // it must be scanned too — but the marker cannot be resolved through
  // locateInstalledApp() here, because after an interrupted swap the path it
  // names no longer validates. Read the raw path instead.
  const dirs = new Set(fallbackDirs);
  const markerAppPath = readMarkerAppPath(
    path.join(traceHomeDir(options.homeDir), LOCATION_MARKER_FILENAME),
  );
  if (markerAppPath) dirs.add(path.dirname(markerAppPath));

  const backupPattern = new RegExp(`^${escapeRegExp(appName)}\\.bak-\\d+$`);
  const actions = [];

  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const appPath = path.join(dir, appName);
    for (const entry of entries) {
      if (!backupPattern.test(entry)) continue;
      const backupPath = path.join(dir, entry);
      try {
        if (fs.existsSync(appPath)) {
          fs.rmSync(backupPath, { recursive: true, force: true });
          actions.push({ action: 'reclaimed', path: backupPath });
        } else if (isValidAppBundle(backupPath, bundleId, plistBuddyBin)) {
          // Only restore something that really is our bundle — never promote
          // a half-extracted directory into the install path.
          fs.renameSync(backupPath, appPath);
          actions.push({ action: 'restored', path: appPath });
        }
      } catch {
        /* best-effort; the next run retries */
      }
    }
  }

  return actions;
}

function readMarkerAppPath(markerPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    return typeof parsed?.appPath === 'string' ? parsed.appPath : null;
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Write the location marker. Called by Electron main on every startup with
 * `process.execPath`-derived path. Best-effort: failures are swallowed
 * because losing the marker degrades gracefully to mdfind fallback.
 *
 * @param {string} appPath  Absolute path to the running `.app` bundle.
 * @param {{ version?: string, homeDir?: string, bundleId?: string }} [meta]
 */
export function writeAppLocationMarker(appPath, meta = {}) {
  // Never record a build output as the install location — see TRA-357.
  if (!isPlausibleInstallPath(appPath)) return;
  try {
    const markerDir = traceHomeDir(meta.homeDir);
    fs.mkdirSync(markerDir, { recursive: true });
    const payload = {
      appPath,
      bundleId: meta.bundleId ?? BUNDLE_ID,
      version: meta.version,
      writtenAt: Date.now(),
    };
    const markerPath = path.join(markerDir, LOCATION_MARKER_FILENAME);
    // Atomic via rename so a concurrent reader never sees a half-written file.
    const tmp = `${markerPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, markerPath);
  } catch {
    /* marker is best-effort; mdfind covers the bootstrap path */
  }
}

function resolveFromMarker(markerPath, bundleId, plistBuddyBin) {
  let raw;
  try {
    raw = fs.readFileSync(markerPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const candidate = typeof parsed?.appPath === 'string' ? parsed.appPath : null;
  if (!candidate) return null;
  // A marker written for a locally built bundle must not win over the real
  // install; fall through to mdfind / the conventional directories instead.
  if (!isPlausibleInstallPath(candidate)) return null;
  if (!isValidAppBundle(candidate, bundleId, plistBuddyBin)) return null;
  return candidate;
}

function resolveFromMdfind(mdfindBin, bundleId, plistBuddyBin) {
  let stdout;
  try {
    stdout = execFileSync(mdfindBin, [`kMDItemCFBundleIdentifier == '${bundleId}'`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 5_000,
    });
  } catch {
    return null;
  }
  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    // Spotlight indexes build outputs too — same filter as the marker path.
    if (!isPlausibleInstallPath(candidate)) continue;
    if (isValidAppBundle(candidate, bundleId, plistBuddyBin)) return candidate;
  }
  return null;
}

/**
 * A path is a valid bundle when it contains `Contents/Info.plist` whose
 * `CFBundleIdentifier` matches `bundleId`. PlistBuddy handles both XML and
 * binary plists; if it is unavailable we fall back to a regex over the raw
 * file (works for the XML plists electron-builder produces).
 */
function isValidAppBundle(candidatePath, bundleId, plistBuddyBin) {
  if (!candidatePath) return false;
  const infoPlist = path.join(candidatePath, 'Contents', 'Info.plist');
  if (!fs.existsSync(infoPlist)) return false;
  try {
    const out = execFileSync(plistBuddyBin, ['-c', 'Print :CFBundleIdentifier', infoPlist], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    return out.trim() === bundleId;
  } catch {
    // PlistBuddy missing or binary plist on a non-Apple host — try a regex
    // over the raw bytes. Good enough for electron-builder XML plists.
    try {
      const raw = fs.readFileSync(infoPlist, 'utf-8');
      const m = raw.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
      return m?.[1]?.trim() === bundleId;
    } catch {
      return false;
    }
  }
}
