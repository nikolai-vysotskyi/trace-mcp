#!/usr/bin/env node

/**
 * apply-pending-update.mjs — invoked detached by the running Electron app
 * via the `restart-app` IPC when a verified update zip is staged at
 * ~/Applications/.trace-mcp-pending.zip. We:
 *
 *   1. Wait for the parent app PID to exit (so the bundle is no longer in use).
 *   2. Re-verify the zip against the staged SHA-256.
 *   3. Extract to a staging dir, Gatekeeper-verify with `spctl`.
 *   4. Atomically swap the staged bundle into place (with rollback on failure).
 *   5. Launch the new app via `open -a` and clear the pending markers.
 *
 * All errors are swallowed silently — a failed apply leaves the previous
 * installation untouched, and the next postinstall run will retry.
 *
 * Usage: node apply-pending-update.mjs <parent-pid>
 *
 * The Electron main process passes its own pid as argv[2]. The helper exits
 * 0 even on failure to avoid noise in detached spawn logs.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'trace-mcp.app';
const INSTALL_DIR = path.join(os.homedir(), 'Applications');
const APP_PATH = path.join(INSTALL_DIR, APP_NAME);
const PENDING_ZIP = path.join(INSTALL_DIR, '.trace-mcp-pending.zip');
const PENDING_VERSION = path.join(INSTALL_DIR, '.trace-mcp-pending-version');
const PENDING_CHECKSUM = path.join(INSTALL_DIR, '.trace-mcp-pending.sha256');
const VERSION_MARKER = path.join(INSTALL_DIR, '.trace-mcp-version');
const LAUNCHER_ENV = path.join(os.homedir(), '.trace-mcp', 'launcher.env');
const DAEMON_PLIST = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  'com.trace-mcp.server.plist',
);
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'trace-mcp');
const LOG_FILE = path.join(LOG_DIR, 'apply-update.log');

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForExit(pid, maxMs = 60_000) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    } // ESRCH = process gone
    await sleep(250);
  }
  return false;
}

function appIsRunning() {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-f', `${APP_NAME}/Contents/MacOS/`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function gatekeeperOk(appPath) {
  try {
    execFileSync('/usr/sbin/spctl', ['-a', '-t', 'exec', appPath], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Symmetric trust: refuse an update that would lower the Gatekeeper trust
// level relative to what the user already has installed. If the installed
// app is unsigned, accept unsigned updates (no-regression). See sibling
// comment in scripts/postinstall-app.mjs.
function trustNotDowngraded(stagedApp, currentApp) {
  const currentTrusted = gatekeeperOk(currentApp);
  if (!currentTrusted) return true;
  return gatekeeperOk(stagedApp);
}

function clearPending() {
  for (const p of [PENDING_ZIP, PENDING_CHECKSUM, PENDING_VERSION]) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

// Parse launcher.env (KEY="value" lines) and return TRACE_MCP_NODE if present.
// launcher.env is written by scripts/postinstall-control-plane.mjs after every
// `npm install -g trace-mcp` and pins the Node interpreter the daemon runs under.
function readLauncherNode() {
  try {
    const raw = fs.readFileSync(LAUNCHER_ENV, 'utf-8');
    const m = raw.match(/^TRACE_MCP_NODE="([^"]+)"/m);
    return m?.[1] ?? '';
  } catch {
    return '';
  }
}

// Read installed CLI package version by walking up from <nodeDir>/../lib/node_modules/trace-mcp.
// We avoid spawning `npm root -g` to keep this fast and dependency-free.
function readInstalledCliVersion(nodeBin) {
  try {
    const nodeDir = path.dirname(nodeBin);
    // Standard layout: <prefix>/bin/node + <prefix>/lib/node_modules/trace-mcp/package.json
    const candidates = [
      path.join(nodeDir, '..', 'lib', 'node_modules', 'trace-mcp', 'package.json'),
      // Some Windows / portable layouts put node_modules next to node.
      path.join(nodeDir, 'node_modules', 'trace-mcp', 'package.json'),
    ];
    for (const pkgPath of candidates) {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (typeof pkg?.version === 'string') return pkg.version;
      }
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Refresh the npm-installed CLI to the matching version so the daemon's
 * cli.js stays in sync with the freshly-swapped .app bundle. Best-effort:
 * any failure is logged and swallowed — we never roll back the bundle swap
 * over a CLI refresh hiccup. The user can always `npm install -g trace-mcp`
 * manually.
 */
function refreshCliPackage(version) {
  if (!version) {
    log('refreshCliPackage: skip (no version)');
    return;
  }
  const nodeBin = readLauncherNode();
  if (!nodeBin) {
    log('refreshCliPackage: skip (launcher.env missing or has no TRACE_MCP_NODE)');
    return;
  }
  if (!fs.existsSync(nodeBin)) {
    log(`refreshCliPackage: skip (TRACE_MCP_NODE not on disk: ${nodeBin})`);
    return;
  }
  // npm sits next to node in the same prefix. Using the launcher's Node
  // guarantees we hit the same global node_modules tree the daemon resolves
  // cli.js from — GUI-spawned processes inherit a stripped PATH, so a bare
  // `npm` could pick a different Node.
  const npmBin = path.join(path.dirname(nodeBin), 'npm');
  if (!fs.existsSync(npmBin)) {
    log(`refreshCliPackage: skip (npm not next to node: ${npmBin})`);
    return;
  }
  const installed = readInstalledCliVersion(nodeBin);
  if (installed === version) {
    log(`refreshCliPackage: skip (already at ${version})`);
    return;
  }
  log(`refreshCliPackage: installing trace-mcp@${version} (was ${installed || 'unknown'})`);
  // Build child env: strip inherited TRACE_MCP_NO_POSTINSTALL so our
  // postinstall-control-plane.mjs can actually run (it refreshes launcher.env,
  // shim, plist). The parent's value (often '1' on CI) must not leak through.
  const npmEnv = { ...process.env };
  delete npmEnv.TRACE_MCP_NO_POSTINSTALL;
  npmEnv.TRACE_MCP_NO_AUTO_UPDATE = '1';
  try {
    const result = spawnSync(npmBin, ['install', '-g', `trace-mcp@${version}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 120_000,
      env: npmEnv,
    });
    if (result.error) {
      log(`refreshCliPackage: spawn error: ${result.error?.message ?? result.error}`);
      return;
    }
    if (result.status !== 0) {
      const tail = (result.stderr ?? '').toString().trim().slice(-500);
      log(
        `refreshCliPackage: npm exited status=${result.status} signal=${result.signal} stderr=${tail}`,
      );
      return;
    }
    log(`refreshCliPackage: ok trace-mcp@${version}`);
  } catch (err) {
    log(`refreshCliPackage: unexpected error: ${err?.message ?? err}`);
  }
}

/**
 * Restart the daemon so it picks up the freshly-installed `trace-mcp` binary.
 * `npm update -g trace-mcp` (run by postinstall) replaces the binary on disk,
 * but the running daemon has the old cli.js loaded into its node process —
 * launchd's KeepAlive only reacts to process exit, not to binary replacement.
 * Explicit unload+load forces launchd to SIGTERM the old process and spawn
 * a fresh one from the new binary.
 */
function restartDaemon() {
  if (!fs.existsSync(DAEMON_PLIST)) return;
  try {
    execFileSync('/bin/launchctl', ['unload', DAEMON_PLIST], { stdio: 'pipe' });
  } catch {}
  try {
    execFileSync('/bin/launchctl', ['load', DAEMON_PLIST], { stdio: 'pipe' });
  } catch {}
}

async function main() {
  log(`start pid=${process.pid} argv=${JSON.stringify(process.argv.slice(2))}`);
  if (process.platform !== 'darwin') {
    log('abort: not darwin');
    return;
  }
  if (!fs.existsSync(PENDING_ZIP) || !fs.existsSync(PENDING_VERSION)) {
    log('abort: no pending zip/version');
    return;
  }
  if (!fs.existsSync(APP_PATH)) {
    log(`abort: APP_PATH missing ${APP_PATH}`);
    return;
  }

  const parentPid = Number(process.argv[2]);
  const exited = await waitForExit(parentPid);
  log(`parent pid=${parentPid} exited=${exited}`);

  // Belt-and-suspenders: if any other instance is still running, bail and let
  // the next exit retry. We never want to swap under a live process.
  if (appIsRunning()) {
    log('abort: app still running after parent exit');
    return;
  }

  // Re-verify the staged zip against the staged checksum. This catches both
  // bit-rot on disk and any tampering between download and apply.
  let expected = '';
  try {
    expected = fs.readFileSync(PENDING_CHECKSUM, 'utf-8').trim().toLowerCase();
  } catch {
    log('abort: cannot read checksum');
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    log(`abort: bad checksum format ${expected.slice(0, 16)}`);
    return;
  }
  const actual = sha256File(PENDING_ZIP).toLowerCase();
  if (actual !== expected) {
    log(`abort: checksum mismatch expected=${expected} actual=${actual}`);
    clearPending();
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-apply-'));
  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    const stagingDir = path.join(tmpDir, 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    try {
      execFileSync('/usr/bin/unzip', ['-q', '-o', PENDING_ZIP, '-d', stagingDir], {
        stdio: 'pipe',
      });
    } catch (err) {
      log(`abort: unzip failed: ${err?.message ?? err}`);
      return;
    }

    const stagedApp = path.join(stagingDir, APP_NAME);
    if (!fs.existsSync(stagedApp)) {
      log(`abort: staged app missing ${stagedApp}`);
      return;
    }
    if (!trustNotDowngraded(stagedApp, APP_PATH)) {
      log('abort: gatekeeper trust downgrade');
      return;
    }

    const backupPath = `${APP_PATH}.bak-${process.pid}`;
    try {
      fs.renameSync(APP_PATH, backupPath);
    } catch (err) {
      log(`abort: rename APP_PATH -> backup failed: ${err?.message ?? err}`);
      return;
    }
    try {
      fs.renameSync(stagedApp, APP_PATH);
    } catch (err) {
      log(`rollback: rename staged -> APP_PATH failed: ${err?.message ?? err}`);
      try {
        fs.renameSync(backupPath, APP_PATH);
      } catch (e2) {
        log(`rollback also failed: ${e2?.message ?? e2}`);
      }
      return;
    }
    fs.rmSync(backupPath, { recursive: true, force: true });
    log(`swapped bundle to ${APP_PATH}`);

    let pendingVersion = '';
    try {
      pendingVersion = fs.readFileSync(PENDING_VERSION, 'utf-8').trim();
    } catch {}
    if (pendingVersion) {
      try {
        fs.writeFileSync(VERSION_MARKER, pendingVersion, 'utf-8');
      } catch (err) {
        log(`warn: version marker write failed: ${err?.message ?? err}`);
      }
    }
    clearPending();

    // Refresh the npm-installed CLI to the matching version. Without this,
    // the GUI update path leaves the daemon binary stuck at whatever was
    // last `npm install`'d, so the .app and cli.js drift out of sync.
    // Best-effort: failures are logged and ignored.
    refreshCliPackage(pendingVersion);

    // Restart the daemon so it runs the newly-installed binary, not the
    // old code pinned in its memory. Order: swap bundle → refresh CLI →
    // restart daemon → relaunch app. App's first /health poll will then
    // see matching versions.
    restartDaemon();

    // Relaunch the new bundle so the user does not have to click anything.
    try {
      const child = spawn('/usr/bin/open', ['-a', APP_PATH], { detached: true, stdio: 'ignore' });
      child.unref();
      log(`relaunch spawned`);
    } catch (err) {
      log(`relaunch spawn failed: ${err?.message ?? err}`);
    }
  } finally {
    cleanup();
  }
}

// Only run main() when invoked as a script — keeps the module importable
// in tests that want to exercise individual helpers like refreshCliPackage
// without triggering the full bundle-swap path.
const invokedAsScript =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedAsScript) {
  main().catch((err) => {
    log(`unhandled: ${err?.stack ?? err}`);
  });
}

// Test-only exports. Not part of any public API; consumed by tests/scripts.
export { refreshCliPackage, readLauncherNode, readInstalledCliVersion };
