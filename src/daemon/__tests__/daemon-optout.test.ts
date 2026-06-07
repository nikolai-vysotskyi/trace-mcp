import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #202: "The daemon keeps getting re-installed". The reported chain was
//   serve (stdio) -> tryAutoSpawnDaemon() -> ensureDaemon() -> ensureDaemonMac()
//   -> ensurePlistInstalled() -> writes plist + launchctl bootstrap
// firing on every session start, so a user who removed the launchd agent had it
// silently reinstalled. The fix: an explicit opt-out sentinel that the
// auto-spawn path honours, plus an idempotent fast-path when the daemon is
// already healthy. These tests pin both without ever touching real launchd.
//
// Safety: every assertion exercises code paths that return BEFORE the
// platform-specific install (ensureDaemonMac / ensureDaemonGeneric), so no
// plist is written to ~/Library/LaunchAgents and no process is spawned.

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no port')));
      }
    });
  });
}

describe('daemon opt-out (#202)', () => {
  let tmpHome: string;
  let lifecycle: typeof import('../lifecycle.js');
  let DAEMON_DISABLED_PATH: string;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-optout-'));
    // TRACE_MCP_DATA_DIR is resolved at import time, so stub it then re-import.
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    lifecycle = await import('../lifecycle.js');
    ({ DAEMON_DISABLED_PATH } = await import('../../global.js'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('round-trips disable/enable through the sentinel file', () => {
    expect(lifecycle.isDaemonDisabled()).toBe(false);

    lifecycle.disableDaemon('test reason');
    expect(lifecycle.isDaemonDisabled()).toBe(true);
    expect(fs.existsSync(DAEMON_DISABLED_PATH)).toBe(true);
    const body = JSON.parse(fs.readFileSync(DAEMON_DISABLED_PATH, 'utf-8'));
    expect(body.reason).toBe('test reason');
    expect(typeof body.disabledAt).toBe('string');

    lifecycle.enableDaemon();
    expect(lifecycle.isDaemonDisabled()).toBe(false);
    expect(fs.existsSync(DAEMON_DISABLED_PATH)).toBe(false);
  });

  it('enableDaemon is idempotent when no opt-out is present', () => {
    expect(() => lifecycle.enableDaemon()).not.toThrow();
    expect(lifecycle.isDaemonDisabled()).toBe(false);
  });

  // The core #202 regression: with the opt-out set, the stdio auto-spawn path
  // must NOT install or spawn anything — it returns a logged no-op so the
  // session runs local-only.
  it('tryAutoSpawnDaemon is a no-op when the daemon is opted out', async () => {
    lifecycle.disableDaemon('user removed the daemon');
    const port = await freePort(); // nothing listening here

    const result = await lifecycle.tryAutoSpawnDaemon(port, 1_000);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/opt-out/i);
    // Returned before acquiring the spawn lock or spawning a detached process.
    expect(fs.existsSync(path.join(tmpHome, 'daemon-spawn.lock'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'daemon.pid'))).toBe(false);
  });

  // ensureDaemon (used by `daemon start` and by auto-spawn) must also honour the
  // opt-out and report strategy 'none' rather than installing.
  it('ensureDaemon refuses to (re)install when opted out', async () => {
    lifecycle.disableDaemon('user removed the daemon');
    const port = await freePort();

    const result = await lifecycle.ensureDaemon({ port });

    expect(result.ok).toBe(false);
    expect(result.strategy).toBe('none');
    expect(fs.existsSync(path.join(tmpHome, 'daemon.pid'))).toBe(false);
  });

  // Idempotency: when a daemon is already healthy, a repeated serve/auto-spawn
  // must short-circuit on the /health fast path and never touch the spawn lock
  // (and therefore never re-bootstrap the plist).
  it('tryAutoSpawnDaemon short-circuits when the daemon is already healthy', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'http' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      const result = await lifecycle.tryAutoSpawnDaemon(port, 1_000);
      expect(result.ok).toBe(true);
      expect(result.alreadyRunning).toBe(true);
      expect(fs.existsSync(path.join(tmpHome, 'daemon-spawn.lock'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
