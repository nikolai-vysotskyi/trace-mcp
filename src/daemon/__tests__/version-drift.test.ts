import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDaemonHealth = vi.fn();
const mockReadLauncherConfig = vi.fn();

vi.mock('../client.js', () => ({
  getDaemonHealth: () => mockGetDaemonHealth(),
}));

vi.mock('../../init/launcher.js', () => ({
  readLauncherConfig: () => mockReadLauncherConfig(),
}));

import {
  checkCliDaemonVersionDrift,
  compareVersions,
  diagnoseVersionDrift,
} from '../version-drift.js';

describe('compareVersions', () => {
  it('correctly compares major versions', () => {
    expect(compareVersions('3.41.0', '4.0.0')).toBe(-1);
    expect(compareVersions('4.0.0', '3.41.0')).toBe(1);
    expect(compareVersions('3.41.0', '3.41.0')).toBe(0);
  });

  it('correctly compares minor versions', () => {
    expect(compareVersions('3.38.0', '3.41.0')).toBe(-1);
    expect(compareVersions('3.41.0', '3.38.0')).toBe(1);
  });

  it('correctly compares patch versions', () => {
    expect(compareVersions('3.41.0', '3.41.1')).toBe(-1);
    expect(compareVersions('3.41.2', '3.41.1')).toBe(1);
  });

  it('handles leading v prefix', () => {
    expect(compareVersions('v3.38.0', '3.41.0')).toBe(-1);
    expect(compareVersions('3.41.0', 'v3.41.0')).toBe(0);
  });
});

describe('checkCliDaemonVersionDrift', () => {
  it('returns dev_build when CLI version is 0.0.0-dev', () => {
    const report = checkCliDaemonVersionDrift({
      cliVersion: '0.0.0-dev',
      daemonVersion: '3.41.0',
      daemonRunning: true,
    });
    expect(report.drift).toBe(false);
    expect(report.status).toBe('dev_build');
  });

  it('returns daemon_offline when daemon is not running', () => {
    const report = checkCliDaemonVersionDrift({
      cliVersion: '3.38.0',
      daemonVersion: null,
      daemonRunning: false,
    });
    expect(report.drift).toBe(false);
    expect(report.status).toBe('daemon_offline');
  });

  it('flags cli_older when CLI in PATH is older than running daemon (TRA-2721 reproduction)', () => {
    const report = checkCliDaemonVersionDrift({
      cliVersion: '3.38.0',
      daemonVersion: '3.41.0',
      launcherVersion: '3.41.0',
      daemonRunning: true,
    });
    expect(report.drift).toBe(true);
    expect(report.status).toBe('cli_older');
    expect(report.warning).toContain(
      'CLI version (3.38.0) is older than the running daemon (3.41.0)',
    );
    expect(report.remedy).toContain('npm i -g trace-mcp@latest');
  });

  it('flags cli_newer when CLI has updated but daemon has not restarted', () => {
    const report = checkCliDaemonVersionDrift({
      cliVersion: '3.42.0',
      daemonVersion: '3.41.0',
      launcherVersion: '3.42.0',
      daemonRunning: true,
    });
    expect(report.drift).toBe(true);
    expect(report.status).toBe('cli_newer');
    expect(report.warning).toContain(
      'CLI version (3.42.0) is newer than the running daemon (3.41.0)',
    );
    expect(report.remedy).toContain('trace-mcp daemon restart');
  });

  it('returns in_sync when CLI and daemon versions match', () => {
    const report = checkCliDaemonVersionDrift({
      cliVersion: '3.41.0',
      daemonVersion: '3.41.0',
      launcherVersion: '3.41.0',
      daemonRunning: true,
    });
    expect(report.drift).toBe(false);
    expect(report.status).toBe('in_sync');
    expect(report.warning).toBeUndefined();
  });

  it('flags cli_older if launcherVersion is newer than both CLI and daemon', () => {
    const report = checkCliDaemonVersionDrift({
      cliVersion: '3.40.0',
      daemonVersion: '3.40.0',
      launcherVersion: '3.41.0',
      daemonRunning: true,
    });
    expect(report.drift).toBe(true);
    expect(report.status).toBe('cli_older');
    expect(report.warning).toContain('older than the control plane launcher');
  });
});

describe('diagnoseVersionDrift integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('diagnoses drift from mocked daemon health and launcher config', async () => {
    mockGetDaemonHealth.mockResolvedValue({
      status: 'ok',
      transport: 'http',
      version: '3.41.0',
      pid: 12345,
    });
    mockReadLauncherConfig.mockReturnValue({
      version: '3.41.0',
    });

    const report = await diagnoseVersionDrift({ cliVersion: '3.38.0' });
    expect(report.drift).toBe(true);
    expect(report.status).toBe('cli_older');
    expect(report.daemonVersion).toBe('3.41.0');
    expect(report.launcherVersion).toBe('3.41.0');
    expect(report.cliVersion).toBe('3.38.0');
  });
});
