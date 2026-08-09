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
