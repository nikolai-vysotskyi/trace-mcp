import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ on: vi.fn() })), execSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, default: { ...actual, existsSync: vi.fn() } };
});
vi.mock('../../src/daemon/client.js', () => ({ getDaemonHealth: vi.fn() }));
vi.mock('../../src/cli/daemon-log-path.js', () => ({ findProcessDaemonLog: vi.fn() }));
vi.mock('../../src/global.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/global.js')>()),
  DAEMON_LOG_PATH: '/cli-home/daemon.log',
}));

const { daemonCommand } = await import('../../src/cli/daemon.js');
const { getDaemonHealth } = await import('../../src/daemon/client.js');
const { findProcessDaemonLog } = await import('../../src/cli/daemon-log-path.js');

const health = vi.mocked(getDaemonHealth);
const resolve = vi.mocked(findProcessDaemonLog);
const tail = vi.mocked(spawn);
const exists = vi.mocked(fs.existsSync);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  exists.mockReturnValue(true);
  health.mockResolvedValue({ status: 'ok', transport: 'http', pid: 19856 });
  resolve.mockReturnValue('/daemon-home/daemon.log');
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

async function logs(...args: string[]): Promise<void> {
  await daemonCommand.parseAsync(['node', 'daemon', 'logs', ...args]);
}

describe('daemon logs', () => {
  it('tails the running daemon profile and names the mismatch', async () => {
    await logs('-n', '60');
    expect(resolve).toHaveBeenCalledWith(19856);
    expect(tail).toHaveBeenCalledWith('tail', ['-n', '60', '/daemon-home/daemon.log'], {
      stdio: 'inherit',
    });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('different profile'));
  });

  it('does not silently tail a stale profile if the running log cannot be found', async () => {
    resolve.mockReturnValue(null);
    await logs();
    expect(tail).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/cli-home/daemon.log'));
  });

  it('allows explicit local log access', async () => {
    await logs('--local');
    expect(health).not.toHaveBeenCalled();
    expect(tail).toHaveBeenCalledWith('tail', ['-n', '50', '/cli-home/daemon.log'], {
      stdio: 'inherit',
    });
  });
});
