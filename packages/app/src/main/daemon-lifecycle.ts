/**
 * Electron-side wrapper over the trace-mcp CLI's `daemon` subcommands.
 *
 * The canonical lifecycle logic lives in src/daemon/lifecycle.ts and is
 * exposed via `trace-mcp daemon start|stop|restart`. This file shells out
 * to that CLI so there's a single source of truth — earlier revisions of
 * this file duplicated the launchd/spawn logic and drifted over time.
 */

import { execFileSync, execSync } from 'child_process';

const isWin = process.platform === 'win32';

function resolveTraceMcpBinary(): string {
  try {
    const cmd = isWin ? 'where trace-mcp' : 'which trace-mcp';
    const out = execSync(cmd, { encoding: 'utf-8' }).trim();
    // `where` on Windows may return several lines; take the first.
    return out.split(/\r?\n/)[0];
  } catch {
    throw new Error('trace-mcp not found in PATH');
  }
}

function runDaemonCommand(subcommand: 'start' | 'stop' | 'restart'): { ok: boolean; error?: string } {
  try {
    const bin = resolveTraceMcpBinary();
    // execFileSync avoids shell-injection concerns around the resolved path.
    // Windows paths may contain spaces; pass as single arg.
    execFileSync(bin, ['daemon', subcommand], {
      stdio: 'pipe',
      windowsHide: true,
      // `shell: true` is required on Windows to resolve .cmd/.bat wrappers
      // that npm global installs generate.
      shell: isWin,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
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
