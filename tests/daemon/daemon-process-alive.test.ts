import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect TRACE_MCP_HOME to an isolated temp dir BEFORE importing anything
// that reads it (global.ts resolves TRACE_MCP_HOME once, at module load, from
// TRACE_MCP_DATA_DIR). This keeps the test from ever touching the real
// ~/.trace-mcp/daemon.pid of a live daemon.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-alive-'));
process.env.TRACE_MCP_DATA_DIR = TMP_HOME;

const { afterAll, afterEach, describe, expect, it } = await import('vitest');
const { isDaemonProcessAlive } = await import('../../src/daemon/lifecycle.js');
const { captureProcessStartToken } = await import('../../src/daemon/lifecycle.js');

const PID_FILE = path.join(TMP_HOME, 'daemon.pid');

/**
 * Issue #237 restart-war guard: an unreachable /health must NOT trigger a
 * kill+restart of a daemon whose OS process is provably alive (it's just busy
 * indexing, event loop starved). isDaemonProcessAlive() is that "provably
 * alive" probe — it reads daemon.pid and verifies ownership.
 */
describe('isDaemonProcessAlive', () => {
  afterEach(() => {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* fine */
    }
  });

  afterAll(() => {
    try {
      fs.rmSync(TMP_HOME, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  });

  it('returns false when there is no pid file', () => {
    expect(isDaemonProcessAlive()).toBe(false);
  });

  it('returns true for the current (provably live) process', () => {
    // Write a valid pid file naming THIS process, with a matching start token
    // so the PID-reuse ownership check passes.
    const token = captureProcessStartToken(process.pid);
    const body = token === null ? `${process.pid}\n` : `${process.pid}\n${token}\n`;
    fs.writeFileSync(PID_FILE, body, { mode: 0o600 });
    expect(isDaemonProcessAlive()).toBe(true);
  });

  it('returns false for a pid that cannot be alive', () => {
    // A very high pid that is not in use — liveness probe fails.
    fs.writeFileSync(PID_FILE, `999999999\n`, { mode: 0o600 });
    expect(isDaemonProcessAlive()).toBe(false);
  });
});
