#!/usr/bin/env node

/**
 * postinstall hook for `npm install -g trace-mcp`.
 *
 * Self-heals the control plane so users don't have to run `trace-mcp init`
 * manually after each install or upgrade. Specifically:
 *
 *   1. Writes ~/.trace-mcp/launcher.env with absolute Node + dist/cli.js paths.
 *   2. Installs the launcher shim at ~/.trace-mcp/bin/trace-mcp (POSIX) or
 *      ~/.trace-mcp/bin/trace-mcp.cmd (Windows) by copying from hooks/.
 *   3. On macOS: installs/refreshes ~/Library/LaunchAgents/com.trace-mcp.server.plist
 *      and bootstraps it with launchd. Kickstarts the service if it was
 *      already loaded so the new binary is picked up.
 *
 * Hardening:
 *   - TRACE_MCP_NO_POSTINSTALL=1 skips entirely.
 *   - Dev checkouts (.git next to package.json) and `npm link` symlinks are skipped.
 *   - TRACE_MCP_MANAGED_BY=launchd: skip (we're being run by launchd, don't recurse).
 *   - CI=true: skip launchd bootstrap (don't pollute CI machines).
 *   - All errors swallowed and logged to ~/.trace-mcp/postinstall.log.
 *   - Daemon is NOT auto-started; only kickstarted if it was already loaded.
 *
 * Runs after preflight-native.mjs and postinstall-app.mjs in the postinstall
 * chain defined in package.json. Always exits 0.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// MUST match src/daemon/lifecycle.ts::PLIST_VERSION — keep in sync.
// Bump there → also bump here. Tested by tests/scripts/postinstall-plist-version.test.ts.
// v3: forces regeneration of v2 plists that embedded a concrete cli.js path
// (drift between src/daemon/lifecycle.ts and this script). v3 uses the launcher
// shim everywhere so node-version swaps don't pin the daemon to a stale binary.
const PLIST_VERSION = 3;
const PLIST_LABEL = 'com.trace-mcp.server';
const PLIST_MARKER = `trace-mcp plist v${PLIST_VERSION}`;
const DEFAULT_DAEMON_PORT = 3741;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// scripts/postinstall-control-plane.mjs → package root is two levels up.
const PKG_ROOT = path.resolve(__dirname, '..');

const TRACE_MCP_HOME = (() => {
  const override = process.env.TRACE_MCP_DATA_DIR || process.env.TRACE_MCP_HOME;
  if (override && override.length > 0) {
    const expanded = override.startsWith('~')
      ? path.join(os.homedir(), override.slice(1))
      : override;
    return path.resolve(expanded);
  }
  return path.join(os.homedir(), '.trace-mcp');
})();

const LOG_PATH = path.join(TRACE_MCP_HOME, 'postinstall.log');
const LAUNCHER_DIR = path.join(TRACE_MCP_HOME, 'bin');
const LAUNCHER_ENV_PATH = path.join(TRACE_MCP_HOME, 'launcher.env');
const DAEMON_LOG_PATH = path.join(TRACE_MCP_HOME, 'daemon.log');
// Opt-out sentinel (#202) — keep in sync with src/global.ts::DAEMON_DISABLED_PATH.
const DAEMON_DISABLED_PATH = path.join(TRACE_MCP_HOME, 'daemon.disabled');
const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  'com.trace-mcp.server.plist',
);

const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(step, result) {
  try {
    ensureDir(TRACE_MCP_HOME);
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_PATH, `[${ts}] ${step}: ${result}\n`);
    truncateLog();
  } catch {
    /* logging must never throw */
  }
}

function truncateLog() {
  // Keep last 200 lines so the log doesn't grow unbounded across many installs.
  try {
    const content = fs.readFileSync(LOG_PATH, 'utf-8');
    const lines = content.split('\n');
    if (lines.length <= 220) return;
    const trimmed = lines.slice(-200).join('\n');
    fs.writeFileSync(LOG_PATH, trimmed);
  } catch {
    /* ignore */
  }
}

function atomicWrite(filePath, content, mode) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, filePath);
}

// Mirror src/updater.ts::isDevCheckout — skip when running from a working tree
// (.git next to package.json) or when the package dir is a symlink (`npm link`).
function isDevCheckout() {
  try {
    if (fs.lstatSync(PKG_ROOT).isSymbolicLink()) return true;
    if (fs.existsSync(path.join(PKG_ROOT, '.git'))) return true;
    return false;
  } catch {
    return false;
  }
}

function quoteEnvValue(v) {
  // Mirror src/init/launcher.ts::quoteEnvValue. The shim strips one pair of
  // surrounding double-quotes and performs no expansion.
  if (v.includes('"')) {
    throw new Error(`launcher config value contains unsupported character ": ${v}`);
  }
  return `"${v}"`;
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function writeLauncherEnv(nodePath, cliPath, version) {
  // Forward slashes in launcher.env: node accepts them everywhere, and it keeps
  // the file portable instead of baking in Windows backslashes the shim then
  // has to re-escape. cliPath is passed to node as a script arg, so '/' is safe.
  const cliPathPortable = cliPath.replaceAll('\\', '/');
  const lines = [
    '# Managed by trace-mcp postinstall — do not edit by hand.',
    '# Regenerated each time npm install -g trace-mcp runs.',
    `TRACE_MCP_NODE=${quoteEnvValue(nodePath)}`,
    `TRACE_MCP_CLI=${quoteEnvValue(cliPathPortable)}`,
    `TRACE_MCP_VERSION=${quoteEnvValue(version)}`,
    '',
  ];
  atomicWrite(LAUNCHER_ENV_PATH, lines.join('\n'), 0o600);
}

function installLauncherShim() {
  // Windows ships .cmd + .ps1; POSIX a single bash script.
  const artifacts = IS_WINDOWS
    ? [
        { src: 'trace-mcp-launcher.cmd', dest: 'trace-mcp.cmd' },
        { src: 'trace-mcp-launcher.ps1', dest: 'trace-mcp-launcher.ps1' },
      ]
    : [{ src: 'trace-mcp-launcher.sh', dest: 'trace-mcp' }];

  ensureDir(LAUNCHER_DIR);
  for (const a of artifacts) {
    const srcPath = path.join(PKG_ROOT, 'hooks', a.src);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`missing launcher source: ${srcPath}`);
    }
    const destPath = path.join(LAUNCHER_DIR, a.dest);
    const content = fs.readFileSync(srcPath);
    const tmp = `${destPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, content, { mode: 0o755 });
    fs.renameSync(tmp, destPath);
    if (!IS_WINDOWS) fs.chmodSync(destPath, 0o755);
  }
}

// ── macOS launchd helpers ─────────────────────────────────────────────

function runQuiet(file, args) {
  try {
    execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stderr: '' };
  } catch (err) {
    const stderr = (err && err.stderr && err.stderr.toString && err.stderr.toString()) || '';
    return { ok: false, stderr };
  }
}

function getLaunchdDomain() {
  // gui/<uid> is the correct per-user agent domain for bootstrap/kickstart.
  // Postinstall runs as the invoking user, so process.getuid() is correct.
  if (typeof process.getuid !== 'function') return null;
  return `gui/${process.getuid()}`;
}

function resolvePathEnv() {
  // launchd doesn't inherit a shell PATH, so embed it explicitly.
  // Match src/daemon/lifecycle.ts::resolvePathEnv.
  const nodeDir = path.dirname(process.execPath);
  const fallback = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return `${nodeDir}:${fallback}`;
}

function generatePlist(binaryPath, port) {
  // MUST mirror src/daemon/lifecycle.ts::generatePlist. The shim path is used
  // as ProgramArguments[0] so MCP clients and the menu bar app converge on
  // the same stable launcher.
  const envPath = resolvePathEnv();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${PLIST_MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>serve-http</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>TRACE_MCP_MANAGED_BY</key>
    <string>launchd</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${DAEMON_LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${DAEMON_LOG_PATH}</string>
  <key>WorkingDirectory</key>
  <string>${TRACE_MCP_HOME}</string>
</dict>
</plist>
`;
}

function isPlistCurrent() {
  try {
    const contents = fs.readFileSync(LAUNCHD_PLIST_PATH, 'utf-8');
    return contents.includes(PLIST_MARKER);
  } catch {
    return false;
  }
}

function isPlistLoaded() {
  // `launchctl list <label>` exits 0 when loaded, non-zero otherwise.
  const result = runQuiet('/bin/launchctl', ['list', PLIST_LABEL]);
  return result.ok;
}

function bootoutPlist(domain) {
  // Modern replacement for `launchctl unload`. Errors ignored — plist may not
  // currently be bootstrapped, which is fine.
  runQuiet('/bin/launchctl', ['bootout', domain, LAUNCHD_PLIST_PATH]);
  runQuiet('/bin/launchctl', ['unload', LAUNCHD_PLIST_PATH]);
}

function enablePlist(domain) {
  // Clear any persistent disabled state from a prior `launchctl unload -w` or
  // `launchctl disable`. Without this, bootstrap fails with "I/O error: 5".
  // Idempotent — succeeds even if the service was already enabled.
  runQuiet('/bin/launchctl', ['enable', `${domain}/${PLIST_LABEL}`]);
}

function bootstrapPlist(domain) {
  // Always enable first — a stale `disabled` entry from a prior unload -w is
  // the most common reason bootstrap fails on a clean-looking system.
  enablePlist(domain);
  const result = runQuiet('/bin/launchctl', ['bootstrap', domain, LAUNCHD_PLIST_PATH]);
  if (result.ok) return { ok: true };
  // bootstrap fails if the service is already loaded (exit 37 / "Service
  // already loaded"). That's success from our perspective.
  if (
    result.stderr.includes('already loaded') ||
    result.stderr.includes('17: File exists') ||
    result.stderr.includes('Service already loaded')
  ) {
    return { ok: true };
  }
  // Fall back to legacy `load -w` for old macOS without bootstrap.
  const legacy = runQuiet('/bin/launchctl', ['load', '-w', LAUNCHD_PLIST_PATH]);
  if (legacy.ok) return { ok: true };
  return { ok: false, error: result.stderr || legacy.stderr || 'bootstrap failed' };
}

function kickstartPlist(domain) {
  // -k kills the running instance first and resets the throttle so the new
  // binary is picked up.
  return runQuiet('/bin/launchctl', ['kickstart', '-k', `${domain}/${PLIST_LABEL}`]);
}

/**
 * `launchctl kickstart` returns ok the moment launchd accepts the request — it
 * doesn't wait for the daemon to actually start serving. A daemon that crashes
 * on every boot (stale cli.js path, missing native binding) will still report
 * `kickstart: ok` here even as launchd burns through KeepAlive respawns. Poll
 * /health for a few seconds; if it never answers, log a clear warning so the
 * user has a breadcrumb instead of a silently-broken install.
 */
function healthCheckAfterKickstart(port) {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const result = spawnSync(
      '/usr/bin/curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', url],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 3000 },
    );
    if (result.status === 0 && result.stdout && result.stdout.trim() === '200') {
      return { ok: true };
    }
    // Brief pause between probes — small loop, blocking is fine.
    spawnSync('/bin/sleep', ['0.5'], { stdio: 'ignore' });
  }
  return { ok: false };
}

function refreshLaunchAgent(launcherShimPath) {
  if (!IS_MAC) return;
  if (process.env.TRACE_MCP_MANAGED_BY === 'launchd') {
    log('launchd', 'skip (running under launchd, would recurse)');
    return;
  }
  if (process.env.CI === 'true' || process.env.CI === '1') {
    log('launchd', 'skip (CI=true)');
    return;
  }
  const domain = getLaunchdDomain();
  if (!domain) {
    log('launchd', 'skip (process.getuid unavailable)');
    return;
  }

  const wasLoaded = isPlistLoaded();
  const plistExists = fs.existsSync(LAUNCHD_PLIST_PATH);
  const currentMarker = plistExists && isPlistCurrent();

  if (currentMarker && wasLoaded) {
    log('launchd', `plist v${PLIST_VERSION} already current and loaded`);
    // Even if current, kickstart so the freshly-installed binary swaps in.
    const kick = kickstartPlist(domain);
    log('launchd', `kickstart: ${kick.ok ? 'ok' : `failed (${kick.stderr.trim()})`}`);
    if (kick.ok) {
      const health = healthCheckAfterKickstart(DEFAULT_DAEMON_PORT);
      log(
        'launchd',
        health.ok
          ? '/health: responding'
          : `/health: unreachable after 6s — daemon may be crash-looping (check ${path.join(TRACE_MCP_HOME, 'daemon.log')})`,
      );
    }
    return;
  }

  // Need to write/refresh the plist.
  if (plistExists) bootoutPlist(domain);

  const plistContent = generatePlist(launcherShimPath, DEFAULT_DAEMON_PORT);
  try {
    ensureDir(path.dirname(LAUNCHD_PLIST_PATH));
    atomicWrite(LAUNCHD_PLIST_PATH, plistContent, 0o644);
    log('launchd', `wrote plist v${PLIST_VERSION} at ${LAUNCHD_PLIST_PATH}`);
  } catch (err) {
    log('launchd', `plist write failed: ${err.message || err}`);
    return;
  }

  // Always bootstrap. First-install case: the daemon starts immediately via
  // RunAtLoad=true (idle-monitor will self-exit in 15 min if unused). Earlier
  // we deliberately skipped bootstrap on first install, but that created an
  // UX dead end — the Electron app's restart button relies on launchd already
  // knowing the service, and users without the GUI app couldn't start the
  // daemon at all without manual `launchctl bootstrap`. See 1.38 incident.
  const boot = bootstrapPlist(domain);
  log('launchd', `bootstrap: ${boot.ok ? 'ok' : `failed (${(boot.error || '').trim()})`}`);
  // Kickstart only if the daemon was already loaded — picks up the new
  // binary. On first install bootstrap itself starts the daemon, so a
  // kickstart would be a redundant restart.
  if (boot.ok && wasLoaded) {
    const kick = kickstartPlist(domain);
    log('launchd', `kickstart: ${kick.ok ? 'ok' : `failed (${kick.stderr.trim()})`}`);
  }
  // Verify daemon actually came up (either via bootstrap's RunAtLoad or via
  // kickstart). `bootstrap ok` / `kickstart ok` only mean launchd accepted
  // the command; the daemon itself may crash-loop. /health probe surfaces
  // that to the install log.
  if (boot.ok) {
    const health = healthCheckAfterKickstart(DEFAULT_DAEMON_PORT);
    log(
      'launchd',
      health.ok
        ? '/health: responding'
        : `/health: unreachable after 6s — daemon may be crash-looping (check ${path.join(TRACE_MCP_HOME, 'daemon.log')})`,
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  if (process.env.TRACE_MCP_NO_POSTINSTALL === '1') {
    log('start', 'skip (TRACE_MCP_NO_POSTINSTALL=1)');
    return;
  }

  if (isDevCheckout()) {
    log('start', `skip (dev checkout at ${PKG_ROOT})`);
    return;
  }

  log('start', `pkg=${PKG_ROOT} platform=${process.platform} node=${process.execPath}`);

  const nodePath = process.execPath;
  const cliPath = path.join(PKG_ROOT, 'dist', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    log('paths', `dist/cli.js missing at ${cliPath} — aborting (likely npm install before build)`);
    return;
  }
  const version = readPackageVersion();
  log('paths', `node=${nodePath} cli=${cliPath} version=${version}`);

  try {
    writeLauncherEnv(nodePath, cliPath, version);
    log('launcher.env', `wrote ${LAUNCHER_ENV_PATH}`);
  } catch (err) {
    log('launcher.env', `failed: ${err.message || err}`);
  }

  let shimPath = '';
  try {
    installLauncherShim();
    shimPath = path.join(LAUNCHER_DIR, IS_WINDOWS ? 'trace-mcp.cmd' : 'trace-mcp');
    log('shim', `installed ${shimPath}`);
  } catch (err) {
    log('shim', `failed: ${err.message || err}`);
  }

  if (IS_MAC && shimPath) {
    // Respect an explicit daemon opt-out (#202). A user who removed the daemon
    // via `trace-mcp daemon stop` should not have it silently reinstalled on the
    // next `npm install -g` / upgrade. The launcher.env + shim above are still
    // refreshed (harmless, needed if they later re-enable), only the launchd
    // bootstrap is skipped.
    if (fs.existsSync(DAEMON_DISABLED_PATH)) {
      log('launchd', `skip (daemon opt-out present at ${DAEMON_DISABLED_PATH})`);
    } else {
      try {
        refreshLaunchAgent(shimPath);
      } catch (err) {
        log('launchd', `failed: ${err.message || err}`);
      }
    }
  }

  log('done', 'ok');
}

try {
  main();
} catch (err) {
  try {
    log('fatal', String((err && err.stack) || err));
  } catch {
    /* swallow */
  }
}

// Always exit 0 — postinstall must never fail npm install.
process.exit(0);
