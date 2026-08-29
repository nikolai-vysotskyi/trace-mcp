import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate TRACE_MCP_HOME before global.ts resolves it — see
// ../../../tests/daemon/daemon-process-alive.test.ts for the same guard against clobbering a live
// daemon's ~/.trace-mcp/daemon.pid.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-selfpid-'));
process.env.TRACE_MCP_DATA_DIR = TMP_HOME;

const { afterAll, describe, expect, it } = await import('vitest');
const { clearOwnDaemonPidFile, isDaemonProcessAlive, writeOwnDaemonPidFile } = await import(
  '../lifecycle.js'
);

/**
 * TRA-421: daemon.pid used to be written only by `ensureDaemonGeneric` — the
 * detached-spawn path taken on Windows and Linux. Under launchd (macOS, the
 * platform the 626-restarts-in-13-hours loop was observed on) nothing wrote it,
 * so `isDaemonProcessAlive()` — the #237 "don't kill a busy daemon" guard —
 * was hardwired to `false` and every client fell through to kill+restart.
 *
 * The daemon now registers its own PID at startup, on every platform.
 */
describe('daemon self-registers its PID', () => {
  afterAll(() => {
    try {
      fs.rmSync(TMP_HOME, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  });

  it('makes the alive-probe true regardless of how the daemon was started', () => {
    expect(isDaemonProcessAlive()).toBe(false);
    writeOwnDaemonPidFile();
    expect(fs.readFileSync(path.join(TMP_HOME, 'daemon.pid'), 'utf-8')).toMatch(
      new RegExp(`^${process.pid}\\b`),
    );
    expect(isDaemonProcessAlive()).toBe(true);
  });

  it('clears the registration on graceful shutdown', () => {
    writeOwnDaemonPidFile();
    clearOwnDaemonPidFile();
    expect(fs.existsSync(path.join(TMP_HOME, 'daemon.pid'))).toBe(false);
    expect(isDaemonProcessAlive()).toBe(false);
  });
});
