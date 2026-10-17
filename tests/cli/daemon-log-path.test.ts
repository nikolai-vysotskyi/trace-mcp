import { describe, expect, it, vi } from 'vitest';

const { lsof, readlink } = vi.hoisted(() => ({ lsof: vi.fn(), readlink: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: lsof }));
vi.mock('node:fs', () => ({ default: { readlinkSync: readlink } }));

const { findProcessDaemonLog } = await import('../../src/cli/daemon-log-path.js');

describe('findProcessDaemonLog', () => {
  it('finds the running daemon log when the CLI and daemon have different homes on macOS', () => {
    lsof.mockReturnValue(
      'p19856\nf1\nn/Users/nikolai/.agy/3/.trace/daemon.log\nf2\nn/Users/nikolai/.agy/3/.trace/daemon.log\n',
    );
    expect(findProcessDaemonLog(19856, 'darwin')).toBe('/Users/nikolai/.agy/3/.trace/daemon.log');
    expect(lsof).toHaveBeenCalledWith(
      'lsof',
      ['-a', '-p', '19856', '-d', '1,2', '-Fn'],
      expect.any(Object),
    );
  });

  it('uses a Linux process descriptor and rejects unrelated files', () => {
    readlink.mockImplementation((p: string) =>
      p.endsWith('/1') ? '/srv/profile/daemon.log' : '/tmp/other.log',
    );
    expect(findProcessDaemonLog(42, 'linux')).toBe('/srv/profile/daemon.log');
  });

  it('fails closed when the PID is invalid or descriptors are unavailable', () => {
    expect(findProcessDaemonLog(-1, 'darwin')).toBeNull();
    lsof.mockImplementation(() => {
      throw new Error('permission denied');
    });
    expect(findProcessDaemonLog(42, 'darwin')).toBeNull();
    expect(findProcessDaemonLog(42, 'win32')).toBeNull();
  });
});
