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
 *   1. **Marker file** `~/.trace-mcp/app-location.json`, written by Electron
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

export const APP_NAME = 'trace-mcp.app';
export const BUNDLE_ID = 'com.trace-mcp.app';
export const LOCATION_MARKER_FILENAME = 'app-location.json';

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
  const markerPath = path.join(home, '.trace-mcp', LOCATION_MARKER_FILENAME);

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
 * Write the location marker. Called by Electron main on every startup with
 * `process.execPath`-derived path. Best-effort: failures are swallowed
 * because losing the marker degrades gracefully to mdfind fallback.
 *
 * @param {string} appPath  Absolute path to the running `.app` bundle.
 * @param {{ version?: string, homeDir?: string, bundleId?: string }} [meta]
 */
export function writeAppLocationMarker(appPath, meta = {}) {
  try {
    const home = meta.homeDir ?? os.homedir();
    const markerDir = path.join(home, '.trace-mcp');
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
