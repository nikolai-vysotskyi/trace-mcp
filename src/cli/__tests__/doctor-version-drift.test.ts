import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockNote = vi.fn();

vi.mock('@clack/prompts', () => ({
  note: (...args: unknown[]) => mockNote(...args),
  intro: vi.fn(),
  outro: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(),
}));

import { printVersionDriftReport } from '../doctor.js';

describe('printVersionDriftReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not print anything when drift is false', () => {
    printVersionDriftReport({
      drift: false,
      cliVersion: '3.41.0',
      daemonVersion: '3.41.0',
      launcherVersion: '3.41.0',
      daemonRunning: true,
      status: 'in_sync',
    });
    expect(mockNote).not.toHaveBeenCalled();
  });

  it('prints formatted note when drift is true', () => {
    printVersionDriftReport({
      drift: true,
      cliVersion: '3.38.0',
      daemonVersion: '3.41.0',
      launcherVersion: '3.41.0',
      daemonRunning: true,
      status: 'cli_older',
      warning: 'CLI version (3.38.0) is older than the running daemon (3.41.0).',
      remedy: "Update the global package in your active PATH ('npm i -g trace-mcp@latest').",
    });
    expect(mockNote).toHaveBeenCalledTimes(1);
    const [message, title] = mockNote.mock.calls[0];
    expect(title).toBe('Version drift detected');
    expect(message).toContain('CLI version:       3.38.0');
    expect(message).toContain('Daemon version:    3.41.0');
    expect(message).toContain('Launcher version:  3.41.0');
    expect(message).toContain('CLI version (3.38.0) is older than the running daemon (3.41.0).');
    expect(message).toContain('Remedy: Update the global package');
  });
});
