#!/usr/bin/env node

/**
 * postinstall hook for `npm install -g trace-mcp`.
 *
 * This is the one-way bridge off the old macOS updater, and nothing else
 * (TRA-437). Builds up to and including 3.8.0 could not update themselves:
 * Squirrel.Mac validates the replacement bundle's code signature and those
 * builds were ad-hoc signed, so the app relied on this hook to download the
 * release zip and swap its `.app`. Builds after that are Developer ID signed
 * and run electron-updater, which owns their bundle completely — a second
 * mechanism writing the same bundle is the failure mode the rewrite deleted.
 *
 * So the hook updates a bundle only when that bundle still ships
 * `Contents/Resources/scripts/apply-pending-update.mjs`. That file is what a
 * legacy build uses to apply a staged zip, so its presence *is* the question
 * "can this bundle only be updated from outside?" — no version constant to
 * keep in sync with whatever release-please picks. Once no legacy bundle is
 * left in the field, everything below the daemon stop can go.
 *
 * Hardening:
 *  - TRACE_MCP_NO_AUTO_UPDATE=1 skips the update entirely.
 *  - TRACE_MCP_APP_RUNNING=1, set by the app on the install it spawns itself,
 *    forces the stage-a-zip path: a live bundle is never replaced in place.
 *  - SHA-256 of the downloaded zip is verified against a sibling
 *    `<asset>.sha256` release asset; if the checksum asset is absent or
 *    the digest does not match, the update is aborted and the installed
 *    app is left untouched.
 *  - The new app is extracted to a temp dir, Gatekeeper-verified with
 *    `spctl`, and only then swapped in — so a failed verification does
 *    not destroy the working installation.
 *  - `unzip` is invoked with execFileSync (no shell) to avoid argument
 *    injection via asset names.
 *
 * Runs silently — never fails the install (all errors are swallowed).
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { getAppDistRepo } from './app-dist-repo.mjs';
import {
  APP_NAME,
  isInstalledApp,
  locateInstalledApp,
  readBundleVersion,
  recoverInterruptedSwap,
  runningBundlePath,
} from './locate-app.mjs';

// Every installed bundle on this machine, the primary target first. Empty
// means no install was found — the script then exits 0 like the old hardcoded
// `!fs.existsSync(APP_PATH)` short-circuit. Pending-zip files are always
// written next to the `.app` they belong to (same filesystem → atomic rename
// works), so their paths are derived per bundle rather than kept here.
let INSTALLED_APPS = [];

// The compiled app is published as release assets on this repo. See
// scripts/app-dist-repo.mjs. Overridable via env.
const GITHUB_REPO = getAppDistRepo();

// Test seams. All default to production values and are only ever set by
// tests/scripts/postinstall-app.test.ts, which needs to point the release
// lookup at a local HTTP server, make "is the app running" deterministic (the
// real pgrep answers differently depending on whether the developer happens to
// have trace-mcp.app open), and avoid bouncing the developer's real daemon.
const API_BASE = process.env.TRACE_MCP_UPDATE_API_BASE || 'https://api.github.com';
const PGREP_BIN = process.env.TRACE_MCP_PGREP_BIN || '/usr/bin/pgrep';
const PS_BIN = process.env.TRACE_MCP_PS_BIN || '/bin/ps';
// The directories a bundle conventionally lives in — same defaults as
// locate-app.mjs. The multi-bundle scan and the orphan sweep below read them,
// and only tests override them: a test must never be able to swap or delete
// anything in the real /Applications on the machine running it.
const CONVENTIONAL_APP_DIRS = (
  process.env.TRACE_MCP_APP_DIRS || `${path.join(os.homedir(), 'Applications')}:/Applications`
)
  .split(':')
  .filter(Boolean);
const LAUNCHCTL_BIN = process.env.TRACE_MCP_LAUNCHCTL_BIN || '/bin/launchctl';

if (process.env.TRACE_MCP_NO_AUTO_UPDATE === '1') process.exit(0);

/**
 * Stop any running `trace-mcp serve-http` daemon so it respawns with the
 * freshly-installed binary. Cross-platform, best-effort, swallows all errors
 * — a failed stop must never fail the install.
 *
 * macOS: `launchctl stop` triggers SIGTERM; the plist's KeepAlive=true auto
 *   respawns the service using the now-updated binary path.
 * Linux/Windows: kill the PID recorded in ~/.trace-mcp/daemon.pid. The next
 *   stdio session or Electron tray poll will ensureDaemon() back up.
 * Manually-spawned dev daemons (no pidfile, no launchd) are not touched —
 *   the developer will restart them as needed.
 */
function stopRunningDaemon() {
  try {
    if (process.platform === 'darwin') {
      execFileSync(LAUNCHCTL_BIN, ['stop', 'com.trace-mcp.server'], { stdio: 'ignore' });
      return;
    }
    const pidFile = path.join(os.homedir(), '.trace-mcp', 'daemon.pid');
    if (!fs.existsSync(pidFile)) return;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already dead */
      }
    }
  } catch {
    /* swallow — postinstall must never fail the install */
  }
}

stopRunningDaemon();

// The staged-zip updater's state file. Nothing reads it since TRA-437, but an
// upgrading user still has one on disk holding a "you are stuck on 3.3.0"
// marker, and a file that outlives its only reader is a trap for the next thing
// that goes looking for state. Deleted here because this hook is the one piece
// of code every upgrading install runs.
try {
  fs.unlinkSync(path.join(os.homedir(), '.trace-mcp', 'app-update-state.json'));
} catch {
  /* absent on a clean machine — the normal case */
}

if (process.platform !== 'darwin') process.exit(0);

// Settle any swap that a reboot or kill interrupted before we try to resolve
// the bundle — otherwise a half-swapped install resolves to nothing and this
// script exits below, leaving the user permanently without an app. This is
// the recovery path that actually fires in practice: the daemon's self-update
// re-runs the postinstall even when the .app cannot be launched at all.
for (const { action, path: target } of recoverInterruptedSwap()) {
  console.log(`  trace-mcp: ${action} ${target} (interrupted update)`);
}

// A running bundle outranks the marker. With two installed copies on one
// machine the marker and the running app can name different bundles, and then
// the pending zip is staged beside a bundle nobody launched: the running copy
// never offers "restart to install" and silently stays behind while npm keeps
// reporting success. Electron main already derives its install dir from
// `process.execPath`, so targeting the running bundle is what makes the two
// sides agree by construction. See runningBundlePath() in locate-app.mjs.
const located = locateInstalledApp();
const running = runningBundlePath({ pgrepBin: PGREP_BIN, psBin: PS_BIN });
const target = running ?? located?.appPath;
if (!target) process.exit(0);
if (running && located && running !== located.appPath) {
  console.log(
    `  trace-mcp: updating the running bundle ${running} (location marker points at ${located.appPath})`,
  );
}

// One machine can hold several installed bundles — dragged into
// `/Applications` once, re-installed into `~/Applications` later. Resolving a
// single target answers "which one do we agree with the app about", but every
// copy we do not touch stays frozen at whatever version it was installed at,
// with no path out: it is not running, so it never writes the location marker,
// so no later install ever resolves to it. Found in the wild at three releases
// behind (`/Applications` on 3.3.0, `~/Applications` on 3.6.0) with npm
// reporting success every time. One download, applied to all of them.
//
// Scope, deliberately: the running bundle, the marker's bundle, and the two
// conventional directories. A copy installed somewhere else that is neither
// running nor the marker target stays invisible here — `mdfind` by bundle id
// would find it, but Spotlight also indexes build trees and external volumes,
// and no user has yet been seen installing outside those directories. Revisit
// if one is.
INSTALLED_APPS = [target];
for (const candidate of [
  ...CONVENTIONAL_APP_DIRS.map((dir) => path.join(dir, APP_NAME)),
  located?.appPath,
]) {
  if (candidate && !INSTALLED_APPS.includes(candidate) && isInstalledApp(candidate)) {
    INSTALLED_APPS.push(candidate);
  }
}
// Bundles that update themselves are not ours to touch. See the header: a
// legacy build carries the apply-pending helper in its Resources, a
// self-updating one does not.
for (const appPath of INSTALLED_APPS.filter((p) => !isLegacyBundle(p))) {
  console.log(`  trace-mcp: ${appPath} updates itself — leaving it alone`);
}
INSTALLED_APPS = INSTALLED_APPS.filter(isLegacyBundle);
if (INSTALLED_APPS.length > 1) {
  console.log(`  trace-mcp: ${INSTALLED_APPS.length} legacy bundles — updating each`);
}

/**
 * True when this bundle can only be updated from outside — i.e. it predates the
 * electron-updater switch (TRA-437).
 *
 * `Contents/Resources/scripts/apply-pending-update.mjs` shipped as an
 * `extraResources` entry for exactly as long as the staged-zip updater existed,
 * and was deleted with it. Keying off the mechanism rather than a version
 * number means nothing here has to be bumped when the next release cuts.
 */
function isLegacyBundle(appPath) {
  return fs.existsSync(
    path.join(appPath, 'Contents', 'Resources', 'scripts', 'apply-pending-update.mjs'),
  );
}

// Reclaim staging aimed at a bundle we are not going to swap: a directory
// holding no legacy install has ~110 MB that nothing will apply and nothing
// will delete. Post-TRA-437 that now includes every directory holding a
// self-updating bundle, which is how a machine that has finished migrating
// gets its last staged zip cleaned up.
const TARGET_DIRS = new Set(INSTALLED_APPS.map((p) => path.dirname(p)));
for (const dir of new Set(
  [...CONVENTIONAL_APP_DIRS, located ? path.dirname(located.appPath) : null].filter(
    (d) => d && !TARGET_DIRS.has(d),
  ),
)) {
  for (const name of [
    '.trace-mcp-pending.zip',
    '.trace-mcp-pending.sha256',
    '.trace-mcp-pending-version',
  ]) {
    try {
      fs.unlinkSync(path.join(dir, name));
      console.log(`  trace-mcp: removed orphaned ${name} in ${dir}`);
    } catch {
      /* absent, or not ours to delete — best-effort like every path here */
    }
  }
}

// Every bundle on this machine is self-updating: the bridge has nothing to do.
if (INSTALLED_APPS.length === 0) process.exit(0);

/**
 * Returns true if the specific installed trace-mcp.app is currently running.
 *
 * `TRACE_MCP_APP_RUNNING=1` is set by the app on the install it spawns itself.
 * On that path, the running bundle is identified via runningBundlePath().
 * For terminal installs (`npm i -g trace-mcp`), pgrep finds all active PIDs and
 * ps resolves their executable path to check if this specific bundle is active.
 *
 * Scoped per bundle: when two installed copies exist (e.g. ~/Applications and
 * /Applications), a running instance of one must not block the other non-running
 * legacy bundle from being swapped in place.
 */
function isAppPathRunning(appPath) {
  if (process.env.TRACE_MCP_APP_RUNNING === '1') {
    const running = runningBundlePath({ pgrepBin: PGREP_BIN, psBin: PS_BIN });
    if (running) return path.resolve(running) === path.resolve(appPath);
    return true;
  }
  try {
    const pids = execFileSync(PGREP_BIN, ['-f', `${APP_NAME}/Contents/MacOS/`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 5_000,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line));

    if (pids.length === 0) return false;

    const targetPrefix = path.resolve(appPath) + path.sep;
    let anyCommResolved = false;
    for (const pid of pids) {
      try {
        const comm = execFileSync(PS_BIN, ['-p', pid, '-o', 'comm='], {
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf-8',
          timeout: 5_000,
        }).trim();
        if (comm) {
          anyCommResolved = true;
          if (comm.startsWith(targetPrefix)) return true;
        }
      } catch {}
    }
    // If ps answered for any pid and none matched this appPath, it is not running.
    // If ps failed on all pids (e.g. test stub with only pgrep), fall back to safe true.
    return !anyCommResolved;
  } catch {
    return false; // pgrep exits 1 when no match
  }
}

function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const doGet = (target, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const mod = target.startsWith('https') ? https : http;
      mod
        .get(
          target,
          {
            timeout: timeoutMs,
            headers: { 'User-Agent': 'trace-mcp', Accept: 'application/vnd.github.v3+json' },
          },
          (res) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
              doGet(res.headers.location, redirects + 1);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => resolve(body));
          },
        )
        .on('error', reject)
        .on('timeout', function () {
          this.destroy();
          reject(new Error('timeout'));
        });
    };
    doGet(url);
  });
}

function downloadFile(url, dest, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const hash = crypto.createHash('sha256');
    const doGet = (target, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const mod = target.startsWith('https') ? https : http;
      mod
        .get(target, { timeout: timeoutMs, headers: { 'User-Agent': 'trace-mcp' } }, (res) => {
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            doGet(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          res.on('data', (chunk) => hash.update(chunk));
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve(hash.digest('hex'));
          });
        })
        .on('error', (err) => {
          fs.unlink(dest, () => {});
          reject(err);
        });
    };
    doGet(url);
  });
}

function parseSha256Manifest(text, assetName) {
  // Accept either a bare digest or `<digest>  <filename>` lines (sha256sum format).
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const bare = line.match(/^([a-f0-9]{64})$/i);
    if (bare) return bare[1].toLowerCase();
    const pair = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (pair && path.basename(pair[2]) === assetName) return pair[1].toLowerCase();
  }
  return null;
}

// Fallback for a bundle whose Info.plist we cannot read (binary plist, damaged
// bundle). Both swap sites write this file, in disagreeing formats — the
// caller strips the leading `v`.
function readMarkerVersion(markerPath) {
  try {
    return fs.readFileSync(markerPath, 'utf-8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function gatekeeperOk(appPath) {
  try {
    execFileSync('/usr/sbin/spctl', ['-a', '-t', 'exec', appPath], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Symmetric trust: a new bundle is acceptable iff its trust level is at least
// as high as the currently-installed bundle. If the installed app is signed +
// notarized (Gatekeeper passes), the update must also pass. If the installed
// app is unsigned (user already accepted that distribution), allow unsigned
// updates — refusing them would brick the auto-update flow for everyone on
// unsigned builds. Once releases are signed + notarized, this check
// automatically becomes strict without code changes.
function trustNotDowngraded(stagedApp, currentApp) {
  const currentTrusted = gatekeeperOk(currentApp);
  if (!currentTrusted) return true;
  return gatekeeperOk(stagedApp);
}

/**
 * Bring one installed bundle to the verified release.
 *
 * Running app → stage the zip beside it and let
 * `scripts/apply-pending-update.mjs` swap on the next restart. Not running →
 * extract to a staging dir, Gatekeeper-check, and swap in place with rollback.
 *
 * @param {string} appPath
 * @param {{ zipPath: string, digest: string, tagName: string, appRunning: boolean, tmpDir: string }} ctx
 */
function applyTo(appPath, { zipPath, digest, tagName, appRunning, tmpDir }) {
  const dir = path.dirname(appPath);
  const pendingZip = path.join(dir, '.trace-mcp-pending.zip');
  const pendingChecksum = path.join(dir, '.trace-mcp-pending.sha256');
  const pendingVersion = path.join(dir, '.trace-mcp-pending-version');
  const versionMarker = path.join(dir, '.trace-mcp-version');

  // If the app is running, do NOT touch the bundle — replacing a running .app
  // can crash lazily-spawned helper processes and break the on-disk code
  // signature that the OS verifies for the running binary. Stage the verified
  // zip + checksum + version so the app can apply it on its own restart via
  // scripts/apply-pending-update.mjs.
  if (appRunning) {
    // Atomic-ish: write to .partial then rename so the app never sees a half-written zip.
    const partial = `${pendingZip}.partial`;
    fs.copyFileSync(zipPath, partial);
    fs.renameSync(partial, pendingZip);
    fs.writeFileSync(pendingChecksum, digest, 'utf-8');
    // Normalize — renderer prepends its own `v`, so `tag_name` raw would
    // display as `vv1.28.0`.
    fs.writeFileSync(pendingVersion, tagName.replace(/^v/, ''), 'utf-8');
    console.log(`  trace-mcp ${tagName} downloaded — restart the app to install`);
    return;
  }

  // App is not running — safe to swap immediately. Extract to staging first
  // and only swap if Gatekeeper approves.
  //
  // Say which signal decided, on the destructive branch only: the TRA-431
  // incident was a `pgrep` false negative that left no trace of itself, so
  // the log could not tell "the app really was closed" from "we failed to
  // notice it". Every future swap now records which of the two this was.
  console.log('  trace-mcp: app not running (pgrep) — replacing the bundle in place');
  const stagingDir = fs.mkdtempSync(path.join(tmpDir, 'staging-'));
  execFileSync('/usr/bin/unzip', ['-q', '-o', zipPath, '-d', stagingDir], { stdio: 'pipe' });

  const stagedApp = path.join(stagingDir, APP_NAME);
  if (!fs.existsSync(stagedApp)) return;
  if (!trustNotDowngraded(stagedApp, appPath)) return;

  const backupPath = `${appPath}.bak-${process.pid}`;
  fs.renameSync(appPath, backupPath);
  try {
    fs.renameSync(stagedApp, appPath);
  } catch (err) {
    try {
      fs.renameSync(backupPath, appPath);
    } catch {}
    throw err;
  }
  fs.rmSync(backupPath, { recursive: true, force: true });
  fs.writeFileSync(versionMarker, tagName, 'utf-8');

  // Clear any stale pending markers from a previous deferred update.
  for (const p of [pendingZip, pendingChecksum, pendingVersion]) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }

  console.log(`  trace-mcp app updated to ${tagName}`);
}

async function main() {
  // macOS release naming: `trace-mcp-<ver>-arm64-mac.zip` (Apple silicon) or
  // `trace-mcp-<ver>-mac.zip` (Intel, no arch marker). The x64 matcher must
  // exclude arm64 to avoid picking the wrong zip when both exist.
  const isArm64 = process.arch === 'arm64';
  const zipPattern = isArm64
    ? /^trace-mcp-.*-arm64-mac\.zip$/i
    : /^trace-mcp-(?!.*-arm64-).*-mac\.zip$/i;

  const body = await httpGet(`${API_BASE}/repos/${GITHUB_REPO}/releases/latest`);
  const release = JSON.parse(body);
  if (!release.tag_name || !Array.isArray(release.assets)) return;

  const asset = release.assets.find((a) => zipPattern.test(a.name));
  if (!asset) return;

  // Guard against shell-hostile asset names even though we use execFileSync.
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(asset.name)) return;

  // Compare with the leading `v` stripped from both sides. The marker has two
  // writers that disagree on format: this script writes `release.tag_name`
  // ("v3.2.0") while apply-pending-update.mjs writes the normalized pending
  // version ("3.2.0"). A raw comparison therefore never matches after a
  // GUI-applied update, so every later `npm install -g trace-mcp` re-downloads
  // the full ~110 MB zip and re-stages the version already installed — and
  // because the apply path rewrites the marker in the same stripped form, the
  // loop never settles: the app shows a permanent "restart to install" banner
  // for the build it is already running.
  //
  // The bundle's own Info.plist wins over the marker file whenever it can be
  // read: the marker says what the last swap intended, the plist says what is
  // actually installed. They diverge whenever a bundle is replaced
  // out-of-band — a hand-dragged older `.app`, a restore from backup — and a
  // marker running ahead of the bundle made this script return 0 silently on
  // every later install, forever. The app meanwhile reads the plist, keeps
  // offering the update, and every attempt lands `npm-only`: the exact
  // TRA-357 shape, with no way out but a manual reinstall (TRA-443).
  const stripV = (v) => v.replace(/^v/, '');
  const stale = INSTALLED_APPS.filter((appPath) => {
    const installed =
      readBundleVersion(appPath) ??
      readMarkerVersion(path.join(path.dirname(appPath), '.trace-mcp-version'));
    return !installed || stripV(installed) !== stripV(release.tag_name);
  });
  if (stale.length === 0) return;

  // Require a sibling checksum asset — no checksum, no update.
  const checksumAsset =
    release.assets.find((a) => a.name === `${asset.name}.sha256`) ||
    release.assets.find((a) => a.name === 'SHASUMS256.txt' || a.name === 'checksums.txt');
  if (!checksumAsset) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-update-'));
  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    const zipPath = path.join(tmpDir, asset.name);
    const actualDigest = await downloadFile(asset.browser_download_url, zipPath);

    const manifestText = await httpGet(checksumAsset.browser_download_url);
    const expectedDigest = parseSha256Manifest(manifestText, asset.name);
    if (!expectedDigest) {
      cleanup();
      return;
    }
    if (expectedDigest !== actualDigest) {
      cleanup();
      return;
    }

    for (const appPath of stale) {
      try {
        applyTo(appPath, {
          zipPath,
          digest: expectedDigest,
          tagName: release.tag_name,
          // Asked per bundle, not once for the whole sweep: swapping a ~100 MB
          // bundle takes seconds, and a user who launches the app during that
          // window would otherwise have the next bundle swapped against a
          // stale "not running" answer — the TRA-431 failure, once per copy.
          appRunning: isAppPathRunning(appPath),
          tmpDir,
        });
      } catch {
        // One unwritable install (a `/Applications` copy owned by another
        // account) must not stop the others from being updated.
      }
    }
  } finally {
    cleanup();
  }
}

main().catch(() => {
  // Never fail the npm install
});
