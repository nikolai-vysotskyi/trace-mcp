#!/usr/bin/env node
/**
 * postinstall hook for `npm install -g trace-mcp`.
 * If the Electron menu bar app is already installed in ~/Applications/,
 * re-download the latest release zip and replace it — so `npm update -g`
 * automatically keeps the GUI app in sync.
 *
 * Hardening:
 *  - TRACE_MCP_NO_AUTO_UPDATE=1 skips the update entirely.
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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const APP_NAME = 'trace-mcp.app';
const INSTALL_DIR = path.join(os.homedir(), 'Applications');
const APP_PATH = path.join(INSTALL_DIR, APP_NAME);
const PENDING_ZIP = path.join(INSTALL_DIR, '.trace-mcp-pending.zip');
const PENDING_VERSION = path.join(INSTALL_DIR, '.trace-mcp-pending-version');
const PENDING_CHECKSUM = path.join(INSTALL_DIR, '.trace-mcp-pending.sha256');
const GITHUB_REPO = 'nikolai-vysotskyi/trace-mcp';

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
      execFileSync('/bin/launchctl', ['stop', 'com.trace-mcp.server'], { stdio: 'ignore' });
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

if (process.platform !== 'darwin' || !fs.existsSync(APP_PATH)) process.exit(0);

/** Returns true if the installed trace-mcp.app is currently running. */
function appIsRunning() {
  try {
    // pgrep -f matches the full command line; the main binary path is unique enough.
    const out = execFileSync('/usr/bin/pgrep', ['-f', `${APP_NAME}/Contents/MacOS/`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim().length > 0;
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

async function main() {
  // macOS release naming: `trace-mcp-<ver>-arm64-mac.zip` (Apple silicon) or
  // `trace-mcp-<ver>-mac.zip` (Intel, no arch marker). The x64 matcher must
  // exclude arm64 to avoid picking the wrong zip when both exist.
  const isArm64 = process.arch === 'arm64';
  const zipPattern = isArm64
    ? /^trace-mcp-.*-arm64-mac\.zip$/i
    : /^trace-mcp-(?!.*-arm64-).*-mac\.zip$/i;

  const body = await httpGet(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  const release = JSON.parse(body);
  if (!release.tag_name || !Array.isArray(release.assets)) return;

  const asset = release.assets.find((a) => zipPattern.test(a.name));
  if (!asset) return;

  // Guard against shell-hostile asset names even though we use execFileSync.
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(asset.name)) return;

  const markerPath = path.join(INSTALL_DIR, '.trace-mcp-version');
  if (fs.existsSync(markerPath)) {
    const installed = fs.readFileSync(markerPath, 'utf-8').trim();
    if (installed === release.tag_name) return;
  }

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

    // If the app is running, do NOT touch the bundle — replacing a running .app
    // can crash lazily-spawned helper processes and break the on-disk code
    // signature that the OS verifies for the running binary. Stage the verified
    // zip + checksum + version so the app can apply it on its own restart via
    // scripts/apply-pending-update.mjs.
    if (appIsRunning()) {
      // Atomic-ish: write to .partial then rename so the app never sees a half-written zip.
      const partial = `${PENDING_ZIP}.partial`;
      fs.copyFileSync(zipPath, partial);
      fs.renameSync(partial, PENDING_ZIP);
      fs.writeFileSync(PENDING_CHECKSUM, expectedDigest, 'utf-8');
      // Normalize — renderer prepends its own `v`, so `tag_name` raw would
      // display as `vv1.28.0`.
      fs.writeFileSync(PENDING_VERSION, release.tag_name.replace(/^v/, ''), 'utf-8');
      cleanup();
      console.log(`  trace-mcp ${release.tag_name} downloaded — restart the app to install`);
      return;
    }

    // App is not running — safe to swap immediately. Extract to staging first
    // and only swap if Gatekeeper approves.
    const stagingDir = path.join(tmpDir, 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    execFileSync('/usr/bin/unzip', ['-q', '-o', zipPath, '-d', stagingDir], { stdio: 'pipe' });

    const stagedApp = path.join(stagingDir, APP_NAME);
    if (!fs.existsSync(stagedApp)) {
      cleanup();
      return;
    }
    if (!trustNotDowngraded(stagedApp, APP_PATH)) {
      cleanup();
      return;
    }

    const backupPath = `${APP_PATH}.bak-${process.pid}`;
    fs.renameSync(APP_PATH, backupPath);
    try {
      fs.renameSync(stagedApp, APP_PATH);
    } catch (err) {
      try {
        fs.renameSync(backupPath, APP_PATH);
      } catch {}
      throw err;
    }
    fs.rmSync(backupPath, { recursive: true, force: true });
    fs.writeFileSync(markerPath, release.tag_name, 'utf-8');

    // Clear any stale pending markers from a previous deferred update.
    for (const p of [PENDING_ZIP, PENDING_CHECKSUM, PENDING_VERSION]) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }

    console.log(`  trace-mcp app updated to ${release.tag_name}`);
  } finally {
    cleanup();
  }
}

main().catch(() => {
  // Never fail the npm install
});
