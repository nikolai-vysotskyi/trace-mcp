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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const APP_NAME = 'trace-mcp.app';
const INSTALL_DIR = path.join(os.homedir(), 'Applications');
const APP_PATH = path.join(INSTALL_DIR, APP_NAME);
const PENDING_ZIP = path.join(INSTALL_DIR, '.trace-mcp-pending.zip');
const PENDING_VERSION = path.join(INSTALL_DIR, '.trace-mcp-pending-version');
const PENDING_CHECKSUM = path.join(INSTALL_DIR, '.trace-mcp-pending.sha256');
const VERSION_MARKER = path.join(INSTALL_DIR, '.trace-mcp-version');
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

    // Restart the daemon so it runs the newly-installed binary, not the
    // old code pinned in its memory. Order: swap bundle → restart daemon →
    // relaunch app. App's first /health poll will then see matching versions.
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

main().catch((err) => {
  log(`unhandled: ${err?.stack ?? err}`);
});
