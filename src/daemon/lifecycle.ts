/**
 * Unified daemon lifecycle management for macOS / Linux / Windows.
 *
 * Provides:
 *   - ensureDaemon()     — if not running, spawn it (platform-appropriate strategy)
 *   - restartDaemon()    — kill existing, start fresh
 *   - stopDaemon()       — unload plist (macOS) or kill PID (Win/Linux)
 *   - waitForDaemonUp()  — poll /health until reachable or timeout
 *   - tryAutoSpawnDaemon() — race-safe spawn from stdio CLI: lock → recheck → spawn → wait
 *
 * Replaces the duplicated logic previously in src/cli/daemon.ts (macOS only)
 * and packages/app/src/main/daemon-lifecycle.ts (electron app).
 */

import { execSync, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DAEMON_LOG_PATH,
  DEFAULT_DAEMON_PORT,
  LAUNCHD_PLIST_PATH,
  TRACE_MCP_HOME,
} from '../global.js';
import { logger } from '../logger.js';
import { atomicWriteString } from '../utils/atomic-write.js';
import { getDaemonHealth, isDaemonRunning } from './client.js';

const PLIST_LABEL = 'com.trace-mcp.server';
// Bump when the plist contents (env vars, args, KeepAlive policy, throttle) change.
// ensureDaemonMac regenerates the plist when the marker below is absent.
const PLIST_VERSION = 2;
const PLIST_MARKER = `trace-mcp plist v${PLIST_VERSION}`;
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

function getLaunchdDomain(): string {
  // gui/<uid> is the correct per-user agent domain for bootstrap/kickstart.
  return `gui/${process.getuid?.() ?? ''}`;
}

function runQuiet(cmd: string): { ok: boolean; stderr?: string } {
  try {
    execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: { toString?: () => string } })?.stderr;
    return { ok: false, stderr: stderr?.toString?.() ?? String(err) };
  }
}

export interface EnsureResult {
  ok: boolean;
  alreadyRunning?: boolean;
  error?: string;
  /** Informational: which strategy was used to start (if started). */
  strategy?: 'launchd' | 'detached' | 'already-running' | 'none';
}

// ── Platform: macOS (launchd) ───────────────────────────────────────

function resolveTraceMcpBinary(): string {
  // Prefer the currently-running binary if it's the CLI.
  const argv1 = process.argv[1];
  if (argv1 && fs.existsSync(argv1) && /trace-mcp/.test(argv1)) {
    return path.resolve(argv1);
  }
  try {
    const cmd = isWin ? 'where trace-mcp' : 'which trace-mcp';
    const out = execSync(cmd, { encoding: 'utf-8' }).trim();
    return out.split(/\r?\n/)[0];
  } catch {
    throw new Error('Could not find trace-mcp binary in PATH');
  }
}

function resolvePathEnv(): string {
  // launchd doesn't inherit a shell PATH, so embed it explicitly.
  const nodeDir = path.dirname(process.execPath);
  const fallback = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return `${nodeDir}:${fallback}`;
}

function generatePlist(binaryPath: string, port: number): string {
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

function isPlistCurrent(): boolean {
  try {
    const contents = fs.readFileSync(LAUNCHD_PLIST_PATH, 'utf-8');
    return contents.includes(PLIST_MARKER);
  } catch {
    return false;
  }
}

function installPlist(port: number): void {
  const binaryPath = resolveTraceMcpBinary();
  const plistDir = path.dirname(LAUNCHD_PLIST_PATH);
  if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true });
  fs.writeFileSync(LAUNCHD_PLIST_PATH, generatePlist(binaryPath, port), 'utf-8');
}

function _isPlistLoaded(): boolean {
  try {
    const out = execSync(`launchctl list ${PLIST_LABEL} 2>&1`, { encoding: 'utf-8' });
    return !out.includes('Could not find service');
  } catch {
    return false;
  }
}

function bootoutPlist(): void {
  // Modern replacement for `launchctl unload`. Errors ignored — plist may
  // not currently be bootstrapped, which is fine.
  const domain = getLaunchdDomain();
  runQuiet(`launchctl bootout ${domain} "${LAUNCHD_PLIST_PATH}"`);
  // Fall back to deprecated unload as well, in case bootstrap/bootout isn't
  // available (very old macOS) — harmless if it fails.
  runQuiet(`launchctl unload "${LAUNCHD_PLIST_PATH}"`);
}

function bootstrapPlist(): { ok: boolean; error?: string } {
  const domain = getLaunchdDomain();
  const result = runQuiet(`launchctl bootstrap ${domain} "${LAUNCHD_PLIST_PATH}"`);
  if (result.ok) return { ok: true };
  // bootstrap fails if the service is already loaded (exit 37 / "Service
  // already loaded"). That's success from our perspective.
  if (result.stderr?.includes('already loaded') || result.stderr?.includes('17: File exists')) {
    return { ok: true };
  }
  // Fall back to legacy `load` for old macOS.
  const legacy = runQuiet(`launchctl load "${LAUNCHD_PLIST_PATH}"`);
  if (legacy.ok) return { ok: true };
  return { ok: false, error: result.stderr ?? 'bootstrap failed' };
}

function kickstartPlist(): { ok: boolean; error?: string } {
  // -k kills the running instance first (if any) and resets the throttle,
  // which `launchctl load/unload` does not do. This is the key to reliable
  // restart when launchd has given up on a crash-looping service.
  const domain = getLaunchdDomain();
  const result = runQuiet(`launchctl kickstart -k ${domain}/${PLIST_LABEL}`);
  if (result.ok) return { ok: true };
  return { ok: false, error: result.stderr ?? 'kickstart failed' };
}

function ensurePlistInstalled(port: number): { ok: boolean; error?: string; regenerated: boolean } {
  const exists = fs.existsSync(LAUNCHD_PLIST_PATH);
  const current = exists && isPlistCurrent();
  if (current) return { ok: true, regenerated: false };
  if (exists) {
    // Stale plist — bootout the old definition before overwriting so launchd
    // picks up the new ProgramArguments / env / throttle on next bootstrap.
    bootoutPlist();
  }
  try {
    installPlist(port);
  } catch (err) {
    return { ok: false, error: (err as Error).message, regenerated: false };
  }
  return { ok: true, regenerated: true };
}

function ensureDaemonMac(port: number): EnsureResult {
  const install = ensurePlistInstalled(port);
  if (!install.ok) return { ok: false, error: install.error };
  const boot = bootstrapPlist();
  if (!boot.ok) return { ok: false, error: boot.error };
  return { ok: true, strategy: 'launchd' };
}

function stopDaemonMac(): void {
  if (!fs.existsSync(LAUNCHD_PLIST_PATH)) return;
  bootoutPlist();
}

function restartDaemonMac(port: number): EnsureResult {
  // Regenerate stale plist first, then ensure it's loaded, then force kickstart.
  const install = ensurePlistInstalled(port);
  if (!install.ok) return { ok: false, error: install.error };
  const boot = bootstrapPlist();
  if (!boot.ok) return { ok: false, error: boot.error };
  const kick = kickstartPlist();
  if (!kick.ok) return { ok: false, error: kick.error };
  return { ok: true, strategy: 'launchd' };
}

// ── Platform: Windows / Linux (detached process with PID file) ──────

function getPidFilePath(): string {
  return path.join(TRACE_MCP_HOME, 'daemon.pid');
}

/**
 * Capture an opaque process-start identity token alongside the PID.
 *
 * Without this, `process.kill(pid, 0)` false-positives when a PID was reused
 * — most commonly after `docker stop` / `docker start` with a bind-mounted
 * data directory: the new daemon boots as the same low PID (often 11) as the
 * old one, liveness reports "alive", and the daemon refuses to start against
 * its own prior incarnation.
 *
 * Returns `null` when the token cannot be captured (Windows, missing /proc,
 * `ps` failure). Callers must treat `null` as "skip identity check, fall back
 * to liveness-only".
 */
export function captureProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (isWin) return null; // Container PID-reuse scenario doesn't apply on Windows.

  if (process.platform === 'linux') {
    try {
      // /proc/<pid>/stat field 22 = starttime in jiffies since boot.
      // Same signal pgrep/systemd use. Cheap, no exec.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // Field 2 (comm) is parenthesised and may contain spaces. Skip past
      // the closing ')' to start parsing fields from #3.
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) return null;
      const fields = stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      // After the close-paren, fields are 3..end. starttime is field 22 → idx 22-3 = 19.
      const starttime = fields[19];
      if (!starttime || !/^\d+$/.test(starttime)) return null;
      return `linux:${starttime}`;
    } catch {
      return null;
    }
  }

  // POSIX (macOS, BSD, …): ps -p <pid> -o lstart= with LC_ALL=C so the
  // emitted timestamp is locale-independent across environments.
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      timeout: 2_000,
    }).trim();
    if (!out) return null;
    return `posix:${out}`;
  } catch {
    return null;
  }
}

interface PidFilePayload {
  pid: number;
  token: string | null;
}

function parsePidFile(content: string): PidFilePayload | null {
  // Backwards-compatible parser:
  //   line 1 = PID
  //   line 2 (optional) = identity token
  // PID files written by older versions are token-less and validated by
  // liveness alone.
  const lines = content.split(/\r?\n/);
  const pid = parseInt((lines[0] ?? '').trim(), 10);
  if (Number.isNaN(pid)) return null;
  const token = (lines[1] ?? '').trim();
  return { pid, token: token.length > 0 ? token : null };
}

function writePidFile(pid: number, token: string | null): void {
  const body = token === null ? `${pid}\n` : `${pid}\n${token}\n`;
  atomicWriteString(getPidFilePath(), body, { mode: 0o600 });
}

/**
 * Verify a PID file's owner is still the same process we recorded.
 *
 * Returns `true` when:
 *   1. PID file exists, parseable, and the PID is alive, AND
 *   2. either the file lacks an identity token (legacy file → liveness wins),
 *      OR the captured token still matches the recorded one.
 *
 * Returns `false` (and logs the PID-reused case at debug level) when liveness
 * passes but the token mismatches — that's "PID was recycled by an unrelated
 * process".
 */
export function verifyPidFileOwnership(content: string): {
  ok: boolean;
  pid: number | null;
  reason?: string;
} {
  const parsed = parsePidFile(content);
  if (parsed === null) return { ok: false, pid: null, reason: 'unparseable' };

  // Liveness check first.
  try {
    process.kill(parsed.pid, 0);
  } catch {
    return { ok: false, pid: parsed.pid, reason: 'dead' };
  }

  // No recorded token → backwards-compat, accept liveness alone.
  if (parsed.token === null) return { ok: true, pid: parsed.pid };

  const current = captureProcessStartToken(parsed.pid);
  if (current === null) {
    // Couldn't capture (Windows / missing /proc) — accept liveness.
    return { ok: true, pid: parsed.pid };
  }
  if (current === parsed.token) return { ok: true, pid: parsed.pid };
  return { ok: false, pid: parsed.pid, reason: 'pid-reused' };
}

function readDaemonPid(): number | null {
  const pidFile = getPidFilePath();
  if (!fs.existsSync(pidFile)) return null;
  let content: string;
  try {
    content = fs.readFileSync(pidFile, 'utf-8');
  } catch {
    return null;
  }
  const verdict = verifyPidFileOwnership(content);
  if (verdict.ok && verdict.pid !== null) return verdict.pid;
  if (verdict.reason === 'pid-reused') {
    logger.debug?.(
      `daemon.pid identity mismatch (PID ${verdict.pid} reused by unrelated process); discarding`,
    );
  }
  try {
    fs.unlinkSync(pidFile);
  } catch {
    /* noop */
  }
  return null;
}

function stopDaemonByPid(): void {
  const pid = readDaemonPid();
  if (pid === null) return;
  try {
    if (isWin) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    /* already dead */
  }
  try {
    fs.unlinkSync(getPidFilePath());
  } catch {
    /* noop */
  }
}

function ensureDaemonGeneric(port: number): EnsureResult {
  if (readDaemonPid() !== null) {
    return { ok: true, alreadyRunning: true, strategy: 'already-running' };
  }

  if (!fs.existsSync(TRACE_MCP_HOME)) fs.mkdirSync(TRACE_MCP_HOME, { recursive: true });

  let binaryPath: string;
  try {
    binaryPath = resolveTraceMcpBinary();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  let logFd: number;
  try {
    logFd = fs.openSync(DAEMON_LOG_PATH, 'a');
  } catch (err) {
    return { ok: false, error: `Cannot open log: ${(err as Error).message}` };
  }

  try {
    const child = spawn(binaryPath, ['serve-http', '--port', String(port)], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: TRACE_MCP_HOME,
      env: { ...process.env, TRACE_MCP_MANAGED_BY: 'spawn' },
      shell: isWin,
      windowsHide: true,
    });
    child.unref();
    if (child.pid) {
      // Capture identity token immediately so a recycled-PID restart can be
      // distinguished from a real liveness signal. Token capture may fail on
      // very-fresh PIDs or platforms without /proc/ps; in that case we fall
      // back to liveness-only validation (older PID-file shape).
      const token = captureProcessStartToken(child.pid);
      writePidFile(child.pid, token);
    }
  } catch (err) {
    return { ok: false, error: `Spawn failed: ${(err as Error).message}` };
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {
      /* noop */
    }
  }

  return { ok: true, strategy: 'detached' };
}

function restartDaemonGeneric(port: number): EnsureResult {
  stopDaemonByPid();
  return ensureDaemonGeneric(port);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Start the daemon if it's not already running. Returns immediately; the
 * daemon itself may still be initializing. Use waitForDaemonUp() to block
 * until /health responds.
 */
export async function ensureDaemon(opts?: { port?: number }): Promise<EnsureResult> {
  const port = opts?.port ?? DEFAULT_DAEMON_PORT;

  // Fast path: already responding.
  const health = await getDaemonHealth(port);
  if (health) return { ok: true, alreadyRunning: true, strategy: 'already-running' };

  return isMac ? ensureDaemonMac(port) : ensureDaemonGeneric(port);
}

/**
 * Stop the daemon (best-effort).
 */
export function stopDaemon(): void {
  if (isMac) stopDaemonMac();
  else stopDaemonByPid();
}

/**
 * Kill existing daemon then start a fresh one.
 */
export function restartDaemon(opts?: { port?: number }): EnsureResult {
  const port = opts?.port ?? DEFAULT_DAEMON_PORT;
  return isMac ? restartDaemonMac(port) : restartDaemonGeneric(port);
}

/**
 * Poll /health until the daemon responds or the timeout elapses.
 */
export async function waitForDaemonUp(
  port: number,
  timeoutMs = 5_000,
  pollIntervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonRunning(port).catch(() => false)) return true;
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
  }
  return false;
}

// ── Race-safe auto-spawn helper for stdio sessions ──────────────────

const SPAWN_LOCK_PATH = path.join(TRACE_MCP_HOME, 'daemon-spawn.lock');
const SPAWN_LOCK_STALE_MS = 30_000;

/**
 * Acquires a PID-based advisory lock by atomic file creation. Caller MUST
 * call releaseSpawnLock() (even on error) to remove the lock. Returns false
 * if another process currently holds a fresh lock; true if we acquired it
 * (either because no one else held it or the previous holder is dead/stale).
 */
function acquireSpawnLock(): boolean {
  if (!fs.existsSync(TRACE_MCP_HOME)) fs.mkdirSync(TRACE_MCP_HOME, { recursive: true });

  const ownToken = captureProcessStartToken(process.pid);
  const ownPayload = ownToken === null ? `${process.pid}\n` : `${process.pid}\n${ownToken}\n`;

  try {
    // 'wx' = fail if file exists. Atomic on POSIX; best-effort on Windows.
    const fd = fs.openSync(SPAWN_LOCK_PATH, 'wx');
    fs.writeSync(fd, ownPayload);
    fs.closeSync(fd);
    return true;
  } catch {
    // Lock file exists — check if it's stale (dead PID, recycled PID, or older than N ms).
    try {
      const stat = fs.statSync(SPAWN_LOCK_PATH);
      const age = Date.now() - stat.mtimeMs;
      const parsed = parsePidFile(fs.readFileSync(SPAWN_LOCK_PATH, 'utf-8'));
      const dead = parsed === null || !isProcessAliveWithToken(parsed.pid, parsed.token);
      if (dead || age > SPAWN_LOCK_STALE_MS) {
        // Atomic stale-lock takeover: drop the dead file then retry the O_EXCL
        // create. If two callers both detect staleness, only one wins the
        // create — the other catches EEXIST and returns false.
        try {
          fs.unlinkSync(SPAWN_LOCK_PATH);
        } catch {
          // ENOENT — another process already unlinked it; that's fine.
        }
        try {
          const fd = fs.openSync(SPAWN_LOCK_PATH, 'wx');
          fs.writeSync(fd, ownPayload);
          fs.closeSync(fd);
          return true;
        } catch {
          // Lost the race — another process recreated the lock between our
          // unlink and create. They own it now.
          return false;
        }
      }
    } catch {
      /* race with another process — give up */
    }
    return false;
  }
}

function releaseSpawnLock(): void {
  try {
    const parsed = parsePidFile(fs.readFileSync(SPAWN_LOCK_PATH, 'utf-8'));
    if (parsed !== null && parsed.pid === process.pid) {
      fs.unlinkSync(SPAWN_LOCK_PATH);
    }
  } catch {
    /* noop */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Liveness + identity check using the recorded token (when present).
 * Returns true only when the PID is alive AND its identity token still matches
 * the recorded one (or no token was recorded → liveness wins).
 */
function isProcessAliveWithToken(pid: number, recordedToken: string | null): boolean {
  if (!isProcessAlive(pid)) return false;
  if (recordedToken === null) return true;
  const current = captureProcessStartToken(pid);
  if (current === null) return true; // Couldn't capture — accept liveness.
  return current === recordedToken;
}

export interface AutoSpawnResult {
  ok: boolean;
  alreadyRunning?: boolean;
  error?: string;
}

/**
 * Race-safe daemon spawn from a stdio session. Protocol:
 *   1. Quick /health check — if up, return immediately.
 *   2. Acquire advisory lock. If unavailable, another stdio is spawning;
 *      just wait up to timeoutMs for the daemon to come up.
 *   3. After acquiring lock, recheck /health (winner may have finished).
 *   4. If still not running, call ensureDaemon() and waitForDaemonUp().
 *   5. Always release the lock.
 */
export async function tryAutoSpawnDaemon(
  port: number = DEFAULT_DAEMON_PORT,
  timeoutMs: number = 5_000,
): Promise<AutoSpawnResult> {
  // Fast path — already running.
  if (await isDaemonRunning(port).catch(() => false)) {
    return { ok: true, alreadyRunning: true };
  }

  const deadline = Date.now() + timeoutMs;
  const haveLock = acquireSpawnLock();

  if (!haveLock) {
    // Another process is spawning — just wait for /health.
    logger.debug('tryAutoSpawnDaemon: lock held by another process, waiting');
    const waitMs = Math.max(0, deadline - Date.now());
    const up = await waitForDaemonUp(port, waitMs);
    return up
      ? { ok: true, alreadyRunning: true }
      : { ok: false, error: 'timeout waiting for concurrent spawn' };
  }

  try {
    // Recheck health now that we hold the lock — winner might have finished.
    if (await isDaemonRunning(port).catch(() => false)) {
      return { ok: true, alreadyRunning: true };
    }

    logger.info({ port }, 'Auto-spawning daemon');
    const ensureResult = await ensureDaemon({ port });
    if (!ensureResult.ok) {
      logger.warn({ error: ensureResult.error }, 'Auto-spawn ensureDaemon failed');
      return { ok: false, error: ensureResult.error };
    }

    const waitMs = Math.max(0, deadline - Date.now());
    const up = await waitForDaemonUp(port, waitMs);
    if (up) {
      logger.info({ port, strategy: ensureResult.strategy }, 'Auto-spawned daemon is up');
      return { ok: true };
    }

    // Daemon didn't come up in time. One retry with restart (kills zombie if any).
    logger.warn({ port, timeoutMs }, 'Daemon did not come up in time, attempting restart');
    const restartResult = restartDaemon({ port });
    if (!restartResult.ok) {
      return { ok: false, error: restartResult.error };
    }
    const up2 = await waitForDaemonUp(port, 3_000);
    return up2 ? { ok: true } : { ok: false, error: 'daemon did not respond after restart' };
  } finally {
    releaseSpawnLock();
  }
}
