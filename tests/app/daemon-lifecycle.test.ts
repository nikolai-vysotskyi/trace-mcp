/**
 * Tests for the Electron main-process daemon lifecycle wrapper.
 *
 * Real bug being guarded against: GUI-launched Electron apps on macOS do NOT
 * inherit PATH from ~/.zshrc / ~/.bashrc — they get the much smaller
 * /etc/paths + launchd PATH. So `which trace-mcp` returns nothing even when
 * the user clearly has trace-mcp installed (e.g. via Herd's bundled nvm).
 * The launcher shim at $TRACE_MCP_HOME/bin/trace-mcp is the canonical way
 * to find the binary and must be preferred over PATH lookup.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:child_process before importing the module under test so the
// mocked execSync/execFileSync are seen by the closure.
const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

const TMP_BASE = fs.realpathSync(os.tmpdir());

function makeShimDir(): { home: string; binDir: string; shim: string } {
  const home = path.join(
    TMP_BASE,
    `daemon-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const shimName = process.platform === 'win32' ? 'trace-mcp.cmd' : 'trace-mcp';
  const shim = path.join(binDir, shimName);
  return { home, binDir, shim };
}

function writeExecutable(filePath: string, contents = '#!/bin/sh\nexit 0\n'): void {
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

describe('daemon-lifecycle (app main process)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    execSyncMock.mockReset();
    execFileSyncMock.mockReset();
    delete process.env.TRACE_MCP_BIN;
    delete process.env.TRACE_MCP_HOME;
    // Reset module registry so each test re-imports with fresh closure state.
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers the launcher shim under $TRACE_MCP_HOME/bin/trace-mcp over PATH', async () => {
    const { home, shim } = makeShimDir();
    writeExecutable(shim);
    process.env.TRACE_MCP_HOME = home;

    const { restartDaemon } = await import('../../packages/app/src/main/daemon-lifecycle.js');
    const result = restartDaemon();

    expect(result.ok).toBe(true);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0]?.[0]).toBe(shim);
    expect(execFileSyncMock.mock.calls[0]?.[1]).toEqual(['daemon', 'restart']);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('honours TRACE_MCP_BIN env override above everything else', async () => {
    const { home, shim } = makeShimDir();
    writeExecutable(shim);
    process.env.TRACE_MCP_HOME = home;

    const overridePath = path.join(home, 'override-bin');
    writeExecutable(overridePath);
    process.env.TRACE_MCP_BIN = overridePath;

    const { ensureDaemon } = await import('../../packages/app/src/main/daemon-lifecycle.js');
    const result = ensureDaemon();

    expect(result.ok).toBe(true);
    expect(execFileSyncMock.mock.calls[0]?.[0]).toBe(overridePath);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('rejects a TRACE_MCP_BIN override that does not exist', async () => {
    process.env.TRACE_MCP_BIN = path.join(TMP_BASE, 'definitely-not-a-real-binary-xyz');

    const { restartDaemon } = await import('../../packages/app/src/main/daemon-lifecycle.js');
    const result = restartDaemon();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/TRACE_MCP_BIN/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('falls back to which/where when the shim is missing', async () => {
    // No shim installed — point TRACE_MCP_HOME at an empty dir.
    const home = path.join(TMP_BASE, `daemon-lifecycle-noshim-${Date.now()}`);
    fs.mkdirSync(home, { recursive: true });
    process.env.TRACE_MCP_HOME = home;

    execSyncMock.mockReturnValue('/some/path/trace-mcp\n');

    const { stopDaemon } = await import('../../packages/app/src/main/daemon-lifecycle.js');
    const result = stopDaemon();

    expect(result.ok).toBe(true);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0]?.[0]).toBe('/some/path/trace-mcp');

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('throws a helpful error when neither shim nor PATH yield a binary', async () => {
    const home = path.join(TMP_BASE, `daemon-lifecycle-nothing-${Date.now()}`);
    fs.mkdirSync(home, { recursive: true });
    process.env.TRACE_MCP_HOME = home;

    execSyncMock.mockImplementation(() => {
      throw new Error('command not found');
    });

    const { restartDaemon } = await import('../../packages/app/src/main/daemon-lifecycle.js');
    const result = restartDaemon();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/launcher shim not found/);
    expect(result.error).toMatch(/trace-mcp init/);
    expect(result.error).toContain(home);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('rejects a shim file that exists but lacks the executable bit (POSIX only)', async () => {
    if (process.platform === 'win32') return;

    const { home, shim } = makeShimDir();
    fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(shim, 0o644); // not executable
    process.env.TRACE_MCP_HOME = home;

    execSyncMock.mockImplementation(() => {
      throw new Error('command not found');
    });

    const { restartDaemon } = await import('../../packages/app/src/main/daemon-lifecycle.js');
    const result = restartDaemon();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/launcher shim not found/);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('surfaces stderr from the daemon CLI in the error message', async () => {
    const { home, shim } = makeShimDir();
    writeExecutable(shim);
    process.env.TRACE_MCP_HOME = home;

    execFileSyncMock.mockImplementation(() => {
      const err = new Error('Command failed') as Error & {
        stderr: Buffer;
        status: number;
      };
      err.stderr = Buffer.from('socket already in use on port 7337');
      err.status = 1;
      throw err;
    });

    const { restartDaemon } = await import('../../packages/app/src/main/daemon-lifecycle.js');
    const result = restartDaemon();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('socket already in use on port 7337');
    expect(result.error).toContain('daemon restart failed');
    expect(result.error).toContain('exit 1');

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('falls back to stdout when stderr is empty', async () => {
    const { home, shim } = makeShimDir();
    writeExecutable(shim);
    process.env.TRACE_MCP_HOME = home;

    execFileSyncMock.mockImplementation(() => {
      const err = new Error('Command failed') as Error & {
        stdout: Buffer;
        stderr: Buffer;
      };
      err.stdout = Buffer.from('daemon is in an inconsistent state');
      err.stderr = Buffer.from('');
      throw err;
    });

    const { stopDaemon } = await import('../../packages/app/src/main/daemon-lifecycle.js');
    const result = stopDaemon();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('daemon is in an inconsistent state');

    fs.rmSync(home, { recursive: true, force: true });
  });
});
