import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TRA-1911: the daemon died ~hourly with no log line because every death log
// went through async-buffered pino (a `logger.info()` followed by
// `process.exit()` loses its line) and SIGHUP had no handler at all. The sync
// exit breadcrumb is what survives those paths. These tests pin the record
// shape and the sync-write semantics without ever exiting the test process.

describe('daemon exit breadcrumb (TRA-1911)', () => {
  let tmpHome: string;
  let breadcrumb: typeof import('../exit-breadcrumb.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-exitcrumb-'));
    // DAEMON_LOG_PATH resolves at import time, so stub the data dir then re-import.
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    breadcrumb = await import('../exit-breadcrumb.js');
    breadcrumb.__resetExitBreadcrumbForTests();
  });

  afterEach(() => {
    breadcrumb.__resetExitBreadcrumbForTests();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function readLogLines(): Record<string, unknown>[] {
    const logPath = path.join(tmpHome, 'daemon.log');
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it('builds a pino-shaped record carrying code, reason, uptime and rss', () => {
    breadcrumb.noteDaemonShutdownReason('SIGTERM');
    const record = breadcrumb.buildExitBreadcrumb(0);

    expect(record.msg).toBe('Daemon exit (sync breadcrumb)');
    expect(record.exitCode).toBe(0);
    expect(record.shutdownReason).toBe('SIGTERM');
    expect(record.pid).toBe(process.pid);
    expect(record.name).toBe('trace-mcp');
    expect(typeof record.time).toBe('number');
    expect(record.uptimeSec).toEqual(expect.any(Number));
    expect(record.rssMb).toBeGreaterThan(0);
  });

  it('reports a null reason when no shutdown path ran (the silent-death case)', () => {
    const record = breadcrumb.buildExitBreadcrumb(9);
    expect(record.exitCode).toBe(9);
    expect(record.shutdownReason).toBeNull();
  });

  it('appends one parseable NDJSON line to daemon.log, synchronously', () => {
    breadcrumb.noteDaemonShutdownReason('eaddrinuse-bind-race');
    breadcrumb.writeExitBreadcrumbSync();

    const [record, ...rest] = readLogLines();
    expect(rest).toEqual([]);
    expect(record.msg).toBe('Daemon exit (sync breadcrumb)');
    expect(record.exitCode).toBeNull();
    expect(record.shutdownReason).toBe('eaddrinuse-bind-race');
  });

  it('never throws when daemon.log cannot be written', () => {
    expect(() =>
      breadcrumb.writeExitBreadcrumbSync(path.join(tmpHome, 'nope', 'daemon.log')),
    ).not.toThrow();
  });

  it('install registers exactly one exit listener and uninstall removes it', () => {
    const before = process.listenerCount('exit');
    const uninstall = breadcrumb.installDaemonExitBreadcrumb();
    expect(process.listenerCount('exit')).toBe(before + 1);

    // Idempotent: a second install is a no-op, not a second listener.
    const uninstall2 = breadcrumb.installDaemonExitBreadcrumb();
    expect(process.listenerCount('exit')).toBe(before + 1);
    uninstall2();

    uninstall();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('the exit listener writes the breadcrumb for the given code', () => {
    const uninstall = breadcrumb.installDaemonExitBreadcrumb();
    try {
      breadcrumb.noteDaemonShutdownReason('SIGTERM');
      // Grab the registered listener without emitting 'exit' (which would run
      // every other exit handler in the test process, including vitest's).
      const listeners = process.listeners('exit');
      const ours = listeners[listeners.length - 1] as (code: number) => void;
      ours(0);

      const [record] = readLogLines();
      expect(record.exitCode).toBe(0);
      expect(record.shutdownReason).toBe('SIGTERM');
    } finally {
      uninstall();
    }
  });
});
