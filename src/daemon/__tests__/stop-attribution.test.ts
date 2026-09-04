import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logDaemonStopAttribution } from '../../../scripts/daemon-attribution.mjs';

// TRA-850: over 31 hours the daemon was stopped 34 times and only 7 stops had a
// recorded initiator. `logLifecycleRequest` covers stopDaemon/restartDaemon;
// everything else that reaches launchd — the stale-plist bootout inside
// ensurePlistInstalled, kickstart -k, the postinstall scripts — left daemon.log
// with a bare `reason: SIGTERM`. These tests pin the attribution records and the
// shutdown-side context without ever invoking launchctl.

describe('daemon stop attribution (TRA-850)', () => {
  let tmpHome: string;
  let lifecycle: typeof import('../lifecycle.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-stopattr-'));
    // Paths are resolved at import time, so stub the data dir then re-import.
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    lifecycle = await import('../lifecycle.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function readDaemonLog(): Record<string, unknown>[] {
    const logPath = path.join(tmpHome, 'daemon.log');
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it('records who asked for a bootout, so the SIGTERM is not anonymous', () => {
    lifecycle.logLaunchdAction('bootout', 'ensureDaemon: stale plist regenerated');

    const [record, ...rest] = readDaemonLog();
    expect(rest).toEqual([]);
    expect(record.msg).toBe('Daemon bootout requested');
    expect(record.action).toBe('bootout');
    expect(record.via).toBe('ensureDaemon: stale plist regenerated');
    expect(record.requesterPid).toBe(process.pid);
    expect(record.requesterPpid).toBe(process.ppid);
  });

  it('records a kickstart the same way — -k kills the running instance', () => {
    lifecycle.logLaunchdAction('kickstart', 'restartDaemon');

    const [record] = readDaemonLog();
    expect(record.msg).toBe('Daemon kickstart requested');
    expect(record.action).toBe('kickstart');
    expect(record.via).toBe('restartDaemon');
  });

  it('describeStopContext reports the parent PID and never throws without a plist', () => {
    const ctx = lifecycle.describeStopContext();

    expect(ctx.ppid).toBe(process.ppid);
    // The plist lives outside the data dir (~/Library/LaunchAgents), so whether
    // it exists depends on the machine. Either way the field must not be a
    // guess: absent when there is no plist, a real age when there is.
    if (ctx.plistAgeSec !== undefined) expect(ctx.plistAgeSec).toBeGreaterThanOrEqual(0);
  });

  it('the postinstall scripts write the same shape into daemon.log', () => {
    const logPath = path.join(tmpHome, 'daemon.log');
    logDaemonStopAttribution(logPath, 'stop', 'postinstall-app: respawn with new binary');

    const [record] = readDaemonLog();
    expect(record.msg).toBe('Daemon stop requested');
    expect(record.action).toBe('stop');
    expect(record.managedBy).toBe('postinstall');
    expect(record.via).toBe('postinstall-app: respawn with new binary');
  });

  it('attribution never throws when daemon.log cannot be written', () => {
    expect(() =>
      logDaemonStopAttribution(path.join(tmpHome, 'nope', 'daemon.log'), 'stop', 'unwritable'),
    ).not.toThrow();
  });
});
