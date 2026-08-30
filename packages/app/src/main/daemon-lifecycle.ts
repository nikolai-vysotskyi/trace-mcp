/**
 * Electron-side wrapper over the trace-mcp CLI's `daemon` subcommands.
 *
 * The canonical lifecycle logic lives in src/daemon/lifecycle.ts and is
 * exposed via `trace-mcp daemon start|stop|restart`. This file shells out
 * to that CLI so there's a single source of truth — earlier revisions of
 * this file duplicated the launchd/spawn logic and drifted over time.
 *
 * Binary resolution order:
 *   1. TRACE_MCP_BIN env override (dev installs, CI)
 *   2. Launcher shim at $TRACE_MCP_HOME/bin/trace-mcp (or trace-mcp.cmd on
 *      Windows). Installed by `trace-mcp init`. Survives nvm/Herd/Volta/fnm
 *      Node version swaps because the shim resolves Node + cli.js at runtime.
 *   3. `which trace-mcp` / `where trace-mcp` PATH lookup. Often fails when
 *      Electron is launched from Finder — GUI apps inherit PATH from
 *      /etc/paths and launchd, NOT from ~/.zshrc / ~/.bashrc, so a Herd /
 *      nvm-installed binary won't be visible here.
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

// Mirrors src/init/launcher.ts: getLauncherDir() — keep in sync if that
// function changes. We don't import from src/init/launcher.ts because the
// Electron main bundle is compiled standalone (tsconfig.main.json rootDir
// is packages/app/src/main) and pulling in the launcher module would drag
// the entire init subsystem into the app build.
function getLauncherDir(): string {
  const envDir = process.env.TRACE_MCP_HOME?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), '.trace-mcp');
}

function getLauncherShimPath(): string {
  const basename = isWin ? 'trace-mcp.cmd' : 'trace-mcp';
  return path.join(getLauncherDir(), 'bin', basename);
}

// On POSIX, require the file exists AND has at least one executable bit set.
// On Windows there is no executable bit — existence is enough; .cmd extension
// is what Windows uses to decide executability.
function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (isWin) return true;
    // 0o111 = any of user/group/other execute bits
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function resolveTraceMcpBinary(): string {
  // 1. Explicit override — dev (npm link) and CI both rely on this.
  const override = process.env.TRACE_MCP_BIN?.trim();
  if (override) {
    if (!isExecutableFile(override)) {
      throw new Error(
        `TRACE_MCP_BIN is set to "${override}" but that file does not exist or is not executable`,
      );
    }
    return override;
  }

  // 2. Launcher shim — canonical, no-shell, survives Node version swaps.
  const shim = getLauncherShimPath();
  if (isExecutableFile(shim)) return shim;

  // 3. PATH fallback — likely to fail in GUI-launched Electron, which is
  // exactly the bug we're working around, but useful for terminal-launched
  // dev runs where ~/.trace-mcp/bin isn't populated yet.
  try {
    const cmd = isWin ? 'where trace-mcp' : 'which trace-mcp';
    const out = execSync(cmd, { encoding: 'utf-8' }).trim();
    // `where` on Windows may return several lines; take the first.
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first) return first;
  } catch {
    // fall through to the unified error below
  }

  throw new Error(
    `trace-mcp launcher shim not found at ${shim} and no trace-mcp in PATH — run 'trace-mcp init' from a terminal first`,
  );
}

function runDaemonCommand(subcommand: 'start' | 'stop' | 'restart'): {
  ok: boolean;
  error?: string;
} {
  let bin: string;
  try {
    bin = resolveTraceMcpBinary();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  try {
    // execFileSync avoids shell-injection concerns around the resolved path.
    // Windows paths may contain spaces; pass as single arg.
    execFileSync(bin, ['daemon', subcommand], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // `shell: true` is required on Windows to resolve .cmd/.bat wrappers
      // that npm global installs generate.
      shell: isWin,
      encoding: 'utf-8',
    });
    return { ok: true };
  } catch (err) {
    // execFileSync attaches stdout/stderr buffers to the thrown error in
    // pipe mode. Surface stderr (which the CLI uses for error reporting)
    // back to the renderer so the menu bar can show a real reason instead
    // of "command failed with code 1".
    const e = err as NodeJS.ErrnoException & {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      status?: number | null;
    };
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    const detail = stderr || stdout || e.message;
    const exitCode = typeof e.status === 'number' ? ` (exit ${e.status})` : '';
    return { ok: false, error: `daemon ${subcommand} failed${exitCode}: ${detail}` };
  }
}

export function ensureDaemon(): { ok: boolean; error?: string } {
  return runDaemonCommand('start');
}

export function restartDaemon(): { ok: boolean; error?: string } {
  return runDaemonCommand('restart');
}

export function stopDaemon(): { ok: boolean; error?: string } {
  return runDaemonCommand('stop');
}

/**
 * Is the daemon process provably alive right now, independent of /health?
 *
 * Mirrors src/daemon/lifecycle.ts: isDaemonProcessAlive(). Kept as a local
 * ~10-line read for the same reason getLauncherDir() is duplicated above — the
 * Electron main bundle compiles standalone and cannot import from src/.
 *
 * The daemon registers its own PID at startup (TRA-421), so an unanswered
 * /health with this returning `true` means "busy", not "dead".
 */
export function isDaemonProcessAlive(): boolean {
  try {
    const raw = fs.readFileSync(path.join(getLauncherDir(), 'daemon.pid'), 'utf-8');
    const pid = parseInt(raw.split(/\r?\n/)[0]?.trim() ?? '', 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // signal 0 = liveness probe, delivers nothing
    return true;
  } catch {
    return false;
  }
}

/**
 * How long a live-but-unresponsive daemon is left alone before the watchdog
 * treats it as wedged and restarts it anyway. A cold start over O(40)
 * registered projects can starve the event loop well past the 5s /health
 * timeout; restarting mid-startup just replays the same slow start.
 */
export const WEDGED_DAEMON_MS = 5 * 60_000;

/**
 * How long a *gone* daemon is left alone before the watchdog restarts it again.
 * launchd's own `ThrottleInterval` is 5s, so between our kill and the
 * replacement's PID registration there is a window in which `daemon.pid` names
 * a dead process. Without a floor here the watchdog fires a second restart into
 * that window — 111 of the 809 restart requests in the TRA-543 sample landed
 * less than 10s after the previous one.
 */
export const DEAD_DAEMON_MS = 10_000;

/** Upper bound on the escalating restart interval. */
export const MAX_RESTART_BACKOFF_MS = 60 * 60_000;

/**
 * Health-watchdog restart policy (TRA-421, extended by TRA-543).
 *
 * The observed failure was 626 daemon restarts in 13 hours: /health timed out
 * while the daemon was busy, the watchdog read that as death, `daemon restart`
 * killed a warming daemon, and the next one started the same slow warm-up. The
 * existing `DAEMON_STARTUP_GRACE_MS` only delayed each iteration — it never
 * broke the cycle, because after the grace window the daemon was still busy.
 *
 * The first rule that breaks it: never kill a process that is provably running.
 * Restart only when the daemon is actually gone, or when it has been alive but
 * mute for longer than any legitimate warm-up.
 *
 * That rule alone was not enough. TRA-543 measured 809 restarts in 22.8 hours
 * on the shipped build — a *fixed* wedged threshold still permits an unbounded
 * loop, because every restart guarantees the next daemon is also mute (a cold
 * start over 66 registered projects takes longer than the threshold). So the
 * threshold escalates: a restart that did not help buys the next daemon twice
 * as long before we conclude the same thing again. `restartsThisOutage` resets
 * when /health answers.
 */
export function shouldRestartUnreachableDaemon(state: {
  processAlive: boolean;
  unreachableForMs: number;
  restartsThisOutage?: number;
  wedgedAfterMs?: number;
}): boolean {
  const base = state.processAlive ? (state.wedgedAfterMs ?? WEDGED_DAEMON_MS) : DEAD_DAEMON_MS;
  const threshold = Math.min(
    base * 2 ** Math.max(0, state.restartsThisOutage ?? 0),
    MAX_RESTART_BACKOFF_MS,
  );
  return state.unreachableForMs >= threshold;
}

/** How many times a given mismatched daemon version is worth restarting away from. */
export const MAX_VERSION_MISMATCH_RESTARTS = 2;

/** What the watchdog remembers between version-mismatch checks. */
export interface VersionMismatchState {
  /** The mismatched daemon version we last acted on, or '' if none. */
  seenVersion: string;
  /** Restarts already spent on `seenVersion`. */
  restarts: number;
}

/**
 * Version-mismatch restart policy (TRA-543).
 *
 * The desktop app restarts the daemon when /health reports a version other than
 * the app's, on the theory that npm swapped the binary and the old code is
 * still resident. That is right once. It is wrong forever: launchd starts
 * whatever is on disk, so if the replacement reports the same version again,
 * no number of further restarts will change it — and the 60 s cooldown that was
 * supposed to "prevent a loop" merely set the loop's period. Measured over
 * 22.8 h on Nikolai's machine: 716 restart requests with a 60.4 s median gap.
 *
 * Caller owns the clock (the cooldown); this owns the budget.
 */
export function nextVersionMismatchAction(
  daemonVersion: string | undefined,
  appVersion: string,
  state: VersionMismatchState,
): { action: 'none' | 'restart' | 'give-up'; state: VersionMismatchState } {
  // No answer, a dev build, or agreement: nothing to do, and agreement clears
  // the budget so a later genuine mismatch starts fresh.
  if (!daemonVersion || daemonVersion === '0.0.0-dev') return { action: 'none', state };
  if (daemonVersion === appVersion) {
    return { action: 'none', state: { seenVersion: '', restarts: 0 } };
  }
  // A *different* mismatched version means the last restart did change
  // something — the new one gets its own attempts.
  const next =
    daemonVersion === state.seenVersion ? state : { seenVersion: daemonVersion, restarts: 0 };
  if (next.restarts >= MAX_VERSION_MISMATCH_RESTARTS) {
    return { action: 'give-up', state: next };
  }
  return { action: 'restart', state: { ...next, restarts: next.restarts + 1 } };
}
