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
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import {
  DAEMON_DISABLED_PATH,
  DAEMON_LOG_PATH,
  DEFAULT_DAEMON_PORT,
  LAUNCHD_PLIST_PATH,
  TRACE_MCP_HOME,
} from '../global.js';
import { readIfExists } from '../utils/safe-fs.js';
import { logger } from '../logger.js';
import { atomicWriteString } from '../utils/atomic-write.js';
import { getDaemonHealth, isDaemonRunning } from './client.js';

const PLIST_LABEL = 'com.trace-mcp.server';
// Bump when the plist contents (env vars, args, KeepAlive policy, throttle) change.
// ensureDaemonMac regenerates the plist when the marker below is absent.
// MUST match scripts/postinstall-control-plane.mjs::PLIST_VERSION — keep in sync.
// v3: prefer the launcher shim as ProgramArguments so Node-version drift can't
// pin the daemon to a stale dist/cli.js.
// v4: ExitTimeOut — launchd's default 5s is shorter than a graceful shutdown
// that closes every project DB, so launchd SIGKILLed the daemon mid-cleanup
// (LastExitStatus=9) and the buffered "Daemon shutting down" line died with it.
const PLIST_VERSION = 4;
/**
 * Seconds launchd waits after SIGTERM before escalating to SIGKILL. Graceful
 * shutdown closes DBs, tears down watchers and flushes indexes for every
 * registered project; on a machine with O(40) projects that does not fit in
 * launchd's 5s default. Must exceed the daemon's own bounded hard-exit
 * (`DAEMON_SHUTDOWN_DEADLINE_MS`, src/server/bounded-shutdown.ts) so *we*
 * decide when to give up, not launchd — asserted by
 * tests/scripts/postinstall-control-plane.test.ts.
 */
const PLIST_EXIT_TIMEOUT_SEC = 30;
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

/**
 * How long a client waits for a provably-alive-but-unresponsive daemon to
 * answer /health again before treating it as wedged and restarting (#237). A
 * heavy reindex can starve the event loop for a couple of minutes; this window
 * must comfortably exceed that so a busy daemon is never killed mid-index.
 */
const ALIVE_DAEMON_BACKOFF_MS = 180_000;

// ── Opt-out sentinel (#202) ─────────────────────────────────────────
// A user who prefers pure stdio can remove the daemon and expect it to stay
// gone. `trace-mcp daemon stop` records an explicit opt-out; auto-spawn then
// becomes a logged no-op instead of silently reinstalling the launchd plist on
// the next session. `daemon start`/`restart` clear the opt-out.

/** True if the user has explicitly opted out of the background daemon. */
export function isDaemonDisabled(): boolean {
  try {
    return fs.existsSync(DAEMON_DISABLED_PATH);
  } catch {
    return false;
  }
}

/** Persist an explicit daemon opt-out. Best-effort; never throws. */
export function disableDaemon(reason: string): void {
  try {
    if (!fs.existsSync(TRACE_MCP_HOME)) fs.mkdirSync(TRACE_MCP_HOME, { recursive: true });
    atomicWriteString(
      DAEMON_DISABLED_PATH,
      `${JSON.stringify({ reason, disabledAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to persist daemon opt-out');
  }
}

/** Clear an explicit daemon opt-out (idempotent). Best-effort; never throws. */
export function enableDaemon(): void {
  try {
    if (fs.existsSync(DAEMON_DISABLED_PATH)) fs.unlinkSync(DAEMON_DISABLED_PATH);
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to clear daemon opt-out');
  }
}

// ── Platform: macOS (launchd) ───────────────────────────────────────

function resolveTraceMcpBinary(): string {
  // Prefer the launcher shim at ~/.trace-mcp/bin/trace-mcp. The shim resolves
  // Node + dist/cli.js at runtime from launcher.env, so the plist survives
  // node-version swaps (nvm/Herd/volta). Without this, the plist embeds a
  // concrete cli.js path; if the user later switches Node, the daemon respawns
  // forever pointed at a stale binary that may not exist or may be from an
  // older trace-mcp install.
  const shimName = isWin ? 'trace-mcp.cmd' : 'trace-mcp';
  const shimPath = path.join(TRACE_MCP_HOME, 'bin', shimName);
  if (fs.existsSync(shimPath)) {
    return shimPath;
  }
  // Fallback: currently-running binary if it's the CLI.
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
  <key>ExitTimeOut</key>
  <integer>${PLIST_EXIT_TIMEOUT_SEC}</integer>
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

// ── Post-mortem: what launchd recorded about the last exit (TRA-267) ─
// When the daemon dies without running a JS handler (OS kill, native crash),
// daemon.log holds no clue. launchd does: it keeps the previous run's exit
// code and, on newer macOS, a termination reason. Surfacing that in
// `daemon status` is the difference between "it vanished" and "SIGKILL".

export interface LaunchdLastExit {
  /** Numeric value launchd reported for the last exit, when it reported one. */
  exitCode?: number;
  /** Free-form reason string when launchd printed one (newer macOS). */
  reason?: string;
  /** Number of times launchd has started the job, when reported. */
  runs?: number;
}

/**
 * Parse the relevant lines out of `launchctl print <domain>/<label>`.
 * Exported for tests — the output format differs across macOS releases, so
 * everything here is best-effort and absent fields are simply omitted.
 */
export function parseLaunchdLastExit(printOutput: string): LaunchdLastExit {
  const out: LaunchdLastExit = {};
  // "last exit code = 9" (older releases say "last exit status").
  const code = printOutput.match(/last exit (?:code|status)\s*=\s*(-?\d+)/);
  if (code) out.exitCode = parseInt(code[1], 10);
  // "last exit reason = <dictionary> ..." / "... = Killed: 9"
  const reason = printOutput.match(/last exit reason\s*=\s*(.+)/);
  if (reason) out.reason = reason[1].trim();
  const runs = printOutput.match(/^\s*runs\s*=\s*(\d+)/m);
  if (runs) out.runs = parseInt(runs[1], 10);
  return out;
}

/**
 * Read launchd's record of the daemon's last exit. macOS only; returns null
 * on other platforms, when the job isn't loaded, or when launchd reported
 * nothing useful.
 */
export function getLaunchdLastExit(): LaunchdLastExit | null {
  if (!isMac) return null;
  let out: string;
  try {
    // execFileSync, not a shell string — no interpolation into a command line.
    out = execFileSync('launchctl', ['print', `${getLaunchdDomain()}/${PLIST_LABEL}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const parsed = parseLaunchdLastExit(out);
  if (parsed.exitCode === undefined && parsed.reason === undefined) return null;
  return parsed;
}

/**
 * Human-readable lines describing launchd's last-exit record, for
 * `trace-mcp daemon status`. Returns [] when there's nothing to say.
 *
 * launchd reports a signalled death and a plain non-zero exit with the same
 * field, so a small-numbered code gets a "possibly SIGx" hint rather than a
 * claim. A SIGKILL here is the fingerprint of an OS memory kill.
 */
export function formatLaunchdLastExit(info: LaunchdLastExit | null): string[] {
  if (!info) return [];
  const lines: string[] = [];
  if (info.exitCode !== undefined) {
    const sig = osConstants.signals as Record<string, number>;
    const name = Object.keys(sig).find((k) => sig[k] === info.exitCode);
    const hint =
      info.exitCode !== 0 && name
        ? ` (possibly ${name} — launchd reports a signalled death and a plain exit code alike)`
        : '';
    lines.push(`  Last exit (launchd): code ${info.exitCode}${hint}`);
  }
  if (info.reason) lines.push(`  Last exit reason: ${info.reason}`);
  if (info.runs !== undefined) lines.push(`  launchd start count: ${info.runs}`);
  return lines;
}

/** Rotate daemon.log once it exceeds this size (bytes). */
const DAEMON_LOG_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Size-capped rotation: daemon.log → daemon.log.1 (previous .1 dropped).
 * daemon.log grew unbounded (149 MB observed in the field) because launchd
 * and the detached-spawn path both append forever. Called only at points
 * where the daemon is about to (re)start — rotating under a live daemon
 * would leave its fd writing to the renamed file.
 */
export function rotateDaemonLogIfLarge(maxBytes: number = DAEMON_LOG_MAX_BYTES): void {
  try {
    const st = fs.statSync(DAEMON_LOG_PATH);
    if (st.size <= maxBytes) return;
    fs.rmSync(`${DAEMON_LOG_PATH}.1`, { force: true });
    fs.renameSync(DAEMON_LOG_PATH, `${DAEMON_LOG_PATH}.1`);
  } catch {
    /* missing file or permission issue — rotation is best-effort */
  }
}

/** How often the running daemon checks its own log size. */
const DAEMON_LOG_ROTATE_INTERVAL_MS = 60_000;

/**
 * Rotate daemon.log from *inside* the running daemon. Its stdout/stderr is an
 * inherited O_APPEND fd on this inode (detached spawn), or launchd's
 * StandardOutPath fd — so a rename would leave the daemon writing to the
 * renamed inode and never recreate daemon.log (which is exactly why the
 * spawn-point `rotateDaemonLogIfLarge` can only run when the daemon is down).
 * Instead copy the contents to daemon.log.1 and truncate the live file to zero:
 * the append fd survives and subsequent writes resume from offset 0
 * (logrotate's `copytruncate`). Best-effort; a write lost across the
 * copy→truncate gap is acceptable for a debug log.
 */
export function rotateDaemonLogInPlace(
  maxBytes: number = DAEMON_LOG_MAX_BYTES,
  logPath: string = DAEMON_LOG_PATH,
): void {
  try {
    const st = fs.statSync(logPath);
    if (st.size <= maxBytes) return;
    fs.copyFileSync(logPath, `${logPath}.1`);
    fs.truncateSync(logPath, 0);
  } catch {
    /* missing file or permission issue — rotation is best-effort */
  }
}

/**
 * Start the periodic in-daemon log-size check and return a stop handle. The
 * spawn-point rotation only fires at (re)start, so a long-lived daemon never
 * rotated and daemon.log grew unbounded (154 MB observed). Unref'd so it never
 * keeps the event loop alive.
 */
export function startDaemonLogRotation(
  intervalMs: number = DAEMON_LOG_ROTATE_INTERVAL_MS,
): () => void {
  rotateDaemonLogInPlace(); // immediate check on boot
  const timer = setInterval(() => rotateDaemonLogInPlace(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function ensureDaemonMac(port: number): EnsureResult {
  rotateDaemonLogIfLarge();
  const install = ensurePlistInstalled(port);
  if (!install.ok) return { ok: false, error: install.error };
  // Idempotent: when the plist was already current AND launchd already has it
  // loaded, skip the redundant `launchctl bootstrap` subprocess (it would just
  // report "already loaded"). A loaded-but-unhealthy service is handled by the
  // caller's kickstart/restart retry path, not by re-bootstrapping here.
  if (!install.regenerated && _isPlistLoaded()) {
    logger.debug('ensureDaemonMac: plist already current and loaded, skipping bootstrap');
    return { ok: true, strategy: 'launchd' };
  }
  const boot = bootstrapPlist();
  if (!boot.ok) return { ok: false, error: boot.error };
  return { ok: true, strategy: 'launchd' };
}

function stopDaemonMac(): void {
  if (!fs.existsSync(LAUNCHD_PLIST_PATH)) return;
  bootoutPlist();
}

function restartDaemonMac(port: number): EnsureResult {
  rotateDaemonLogIfLarge();
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
  let content: string;
  try {
    const raw = readIfExists(pidFile);
    if (raw === null) return null;
    content = raw;
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

/**
 * Append one pino-shaped NDJSON record straight to daemon.log (TRA-421).
 *
 * Attribution has to bypass `logger`, which writes to *this* process's stderr.
 * For the daemon that stderr is daemon.log (launchd redirects it), but for a
 * short-lived `trace-mcp daemon restart` — the process that actually kills the
 * daemon — stderr goes to whoever spawned it, and the desktop app discards it.
 * That is why 626 restarts in one day left no record of who asked for them.
 * Best-effort: a failed append must never break a lifecycle command.
 */
function appendDaemonLog(msg: string, fields: Record<string, unknown>): void {
  try {
    const record = {
      level: 30,
      time: Date.now(),
      pid: process.pid,
      name: 'trace-mcp',
      ...fields,
      msg,
    };
    fs.appendFileSync(DAEMON_LOG_PATH, `${JSON.stringify(record)}\n`);
  } catch {
    /* log attribution is best-effort */
  }
}

/**
 * Who is asking for this stop/restart? `process.argv` of the *calling* CLI plus
 * its parent PID is enough to tell a human `trace-mcp daemon restart` apart
 * from the desktop app's health watchdog apart from a hook-spawned CLI.
 */
function logLifecycleRequest(action: 'stop' | 'restart'): void {
  appendDaemonLog(`Daemon ${action} requested`, {
    action,
    requesterPid: process.pid,
    requesterPpid: process.ppid,
    // argv[0] is node and argv[1] the cli.js path — the subcommand is what matters.
    requesterArgs: process.argv.slice(2, 6),
    managedBy: process.env.TRACE_MCP_MANAGED_BY ?? 'cli',
  });
}

/**
 * Register the *running daemon's* own PID so `isDaemonProcessAlive()` works on
 * every platform (TRA-421).
 *
 * Before this, daemon.pid was written only by `ensureDaemonGeneric` — the
 * detached-spawn path used on Windows/Linux. On macOS the daemon runs under
 * launchd, nobody wrote the file, and so the #237 "provably alive, don't kill a
 * busy daemon" guard silently evaluated to `false` forever on the platform the
 * restart war was actually observed on.
 */
export function writeOwnDaemonPidFile(): void {
  try {
    if (!fs.existsSync(TRACE_MCP_HOME)) fs.mkdirSync(TRACE_MCP_HOME, { recursive: true });
    writePidFile(process.pid, captureProcessStartToken(process.pid));
  } catch (err) {
    logger.warn({ err: String(err) }, 'Could not write daemon.pid');
  }
}

/** How often a serving daemon re-asserts its own daemon.pid (TRA-525). */
export const PID_REASSERT_INTERVAL_MS = 30_000;

/**
 * Re-assert this process's daemon.pid registration if it went missing or was
 * overwritten by another process (TRA-525).
 *
 * `readDaemonPid()` unlinks the file whenever it names a dead process. That is
 * right for a stale file, but it meant one poisoning event — a losing spawn
 * writing its PID and then dying — permanently deleted the live daemon's
 * registration, and nothing ever rewrote it. `isDaemonProcessAlive()` then
 * answered "dead" for the rest of the daemon's life, so every /health miss
 * became a restart.
 *
 * Idempotent: reads first and only writes when the file does not already name
 * this process. Best-effort; never throws.
 */
export function reassertOwnDaemonPidFile(): void {
  try {
    const raw = readIfExists(getPidFilePath());
    if (raw !== null && parsePidFile(raw)?.pid === process.pid) return;
    writeOwnDaemonPidFile();
  } catch {
    /* best-effort — a missed re-assert costs one watchdog cycle, not a crash */
  }
}

/** Remove daemon.pid on graceful shutdown. Best-effort; never throws. */
export function clearOwnDaemonPidFile(): void {
  try {
    fs.unlinkSync(getPidFilePath());
  } catch {
    /* already gone */
  }
}

/**
 * Log what launchd recorded about the *previous* run, at daemon start (TRA-421).
 *
 * `getLaunchdLastExit()` existed (TRA-267) but was only surfaced by
 * `daemon status`, which nobody runs during a crash loop. Emitting it on every
 * boot means daemon.log itself says "the last run died to code 9 after 22s"
 * instead of requiring `launchctl` archaeology after the fact.
 */
export function logPreviousExit(): void {
  const info = getLaunchdLastExit();
  if (!info) return;
  logger.info(
    { exitCode: info.exitCode, exitReason: info.reason, launchdRuns: info.runs },
    'Previous daemon run exited (launchd post-mortem)',
  );
}

function stopDaemonByPid(): void {
  const pid = readDaemonPid();
  if (pid === null) return;
  try {
    if (isWin) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' });
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

/**
 * Is a daemon process provably alive right now? True when daemon.pid names a
 * live, ownership-verified process (guards PID reuse via the start-token).
 *
 * This is the "provably alive" probe the respawn policy leans on (#237): an
 * unreachable /health during a heavy indexing run does NOT mean the daemon is
 * dead — the event loop is just starved and can't answer. A client that would
 * otherwise kill+restart the daemon must first ask this; if it's true, the
 * daemon is busy, not gone, and killing it only feeds the restart war.
 */
export function isDaemonProcessAlive(): boolean {
  return readDaemonPid() !== null;
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
    rotateDaemonLogIfLarge();
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

  // Fast path: already responding. (We never tear down a live daemon, even if
  // an opt-out file is present — only the *start* of a new one is suppressed.)
  const health = await getDaemonHealth(port);
  if (health) return { ok: true, alreadyRunning: true, strategy: 'already-running' };

  // Respect an explicit opt-out (#202): do not (re)install/spawn. Cleared by
  // `trace-mcp daemon start`/`restart`, which call enableDaemon() first.
  if (isDaemonDisabled()) {
    logger.info(
      { sentinel: DAEMON_DISABLED_PATH },
      'Daemon start suppressed by opt-out; run `trace-mcp daemon start` to re-enable',
    );
    return { ok: false, strategy: 'none', error: 'daemon disabled by opt-out' };
  }

  return isMac ? ensureDaemonMac(port) : ensureDaemonGeneric(port);
}

/**
 * Stop the daemon (best-effort).
 */
export function stopDaemon(): void {
  // Record an explicit opt-out so the next stdio session doesn't silently
  // reinstall the daemon the user just removed (#202).
  disableDaemon('trace-mcp daemon stop');
  logLifecycleRequest('stop');
  if (isMac) stopDaemonMac();
  else stopDaemonByPid();
}

/**
 * Kill existing daemon then start a fresh one.
 */
export function restartDaemon(opts?: { port?: number }): EnsureResult {
  const port = opts?.port ?? DEFAULT_DAEMON_PORT;
  // An explicit restart is a clear intent to run the daemon — clear any opt-out.
  enableDaemon();
  logLifecycleRequest('restart');
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

  // Respect an explicit opt-out (#202) before touching the spawn lock or
  // installing anything. This is the fix for "I removed the daemon and it kept
  // coming back": once opted out, stdio sessions run local-only with no reinstall.
  if (isDaemonDisabled()) {
    logger.info(
      { sentinel: DAEMON_DISABLED_PATH },
      'Daemon auto-spawn suppressed by opt-out; running local-only. Re-enable with `trace-mcp daemon start`',
    );
    return { ok: false, error: 'daemon disabled by opt-out' };
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

    // #237 restart-war guard: /health didn't answer in time — but that is NOT
    // proof the daemon is dead. During a heavy reindex the event loop is
    // starved and can't answer /health for minutes, even though the process is
    // alive and making progress. If the daemon process is provably alive
    // (daemon.pid names a live, ownership-verified process), do NOT kill+restart
    // it — that is exactly what fed the restart war (hook-spawned CLIs killing a
    // busy daemon on every Edit). Back off with a generous window instead.
    if (isDaemonProcessAlive()) {
      logger.info(
        { port },
        'Daemon /health slow but process is alive (likely indexing) — backing off instead of restarting',
      );
      // Generous multi-minute wait: an indexing run can starve /health for a
      // couple of minutes. Kill+restart is reserved for a genuinely gone or
      // wedged-beyond-recovery process.
      const backoffUp = await waitForDaemonUp(port, ALIVE_DAEMON_BACKOFF_MS);
      if (backoffUp) {
        logger.info({ port }, 'Daemon became responsive after back-off — no restart needed');
        return { ok: true, alreadyRunning: true };
      }
      // Still no /health after a multi-minute wait AND still alive — genuinely
      // wedged. Fall through to restart as a last resort.
      logger.warn(
        { port, backoffMs: ALIVE_DAEMON_BACKOFF_MS },
        'Daemon still unresponsive after back-off despite live process — restarting as last resort',
      );
    }

    // Daemon is gone (or wedged beyond the back-off). One retry with restart.
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
