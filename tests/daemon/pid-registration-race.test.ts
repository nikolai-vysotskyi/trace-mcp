import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate TRACE_MCP_HOME before anything reads it (global.ts resolves it once,
// at module load) so this never touches a live daemon's ~/.trace-mcp/daemon.pid.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-pidrace-'));
process.env.TRACE_MCP_DATA_DIR = TMP_HOME;

const { afterAll, afterEach, describe, expect, it } = await import('vitest');
const {
  captureProcessStartToken,
  isDaemonProcessAlive,
  reassertOwnDaemonPidFile,
  writeOwnDaemonPidFile,
} = await import('../../src/daemon/lifecycle.js');

const PID_FILE = path.join(TMP_HOME, 'daemon.pid');

/** A PID that cannot be alive — stands in for a spawn that wrote and then died. */
const DEAD_PID = 999_999_999;

/**
 * TRA-525 regression guard.
 *
 * The measured failure: 724 daemon restarts in 18.7h (peak 89/h) on a machine
 * where indexing legitimately starves /health to a p50 of 7.8s.
 *
 * The mechanism was not the starvation itself — the watchdog already refuses to
 * kill a daemon whose process is provably alive (TRA-421). It was that the
 * "provably alive" probe could be made to answer *false about a running daemon*:
 *
 *   1. `daemon restart` spawns a new serve-http.
 *   2. The new process registered its PID in daemon.pid *before* binding.
 *   3. It lost the port race to the still-running old daemon and exited.
 *   4. daemon.pid now named a dead PID while a healthy daemon served traffic,
 *      so isDaemonProcessAlive() said "dead" and the watchdog shot the daemon
 *      that was working — which restarts the same slow warm-up. Loop.
 *
 * Both halves of the fix are guarded here: only a process that owns the port
 * registers at all, and a registration that goes missing is re-asserted.
 */
describe('daemon.pid registration (TRA-525)', () => {
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

  it('a dead PID left in the file makes the liveness guard answer "dead"', () => {
    // Not a fix — the premise. This is what a pre-bind registration by a losing
    // spawn used to leave behind, and why the restart war survived TRA-421.
    fs.writeFileSync(PID_FILE, `${DEAD_PID}\n`, { mode: 0o600 });
    expect(isDaemonProcessAlive()).toBe(false);
  });

  it('re-asserts a registration that was deleted out from under a live daemon', () => {
    writeOwnDaemonPidFile();
    expect(isDaemonProcessAlive()).toBe(true);

    // readDaemonPid() unlinks any file naming a dead process. Before the fix
    // that deletion was permanent for the life of the daemon: nothing rewrote
    // it, so the guard stayed disarmed and every /health miss became a restart.
    fs.unlinkSync(PID_FILE);
    expect(isDaemonProcessAlive()).toBe(false);

    reassertOwnDaemonPidFile();
    expect(isDaemonProcessAlive()).toBe(true);
  });

  it('reclaims the registration when another process overwrote it and died', () => {
    writeOwnDaemonPidFile();
    fs.writeFileSync(PID_FILE, `${DEAD_PID}\n`, { mode: 0o600 });
    expect(isDaemonProcessAlive()).toBe(false);

    reassertOwnDaemonPidFile();
    expect(isDaemonProcessAlive()).toBe(true);
    expect(fs.readFileSync(PID_FILE, 'utf-8').split('\n')[0]).toBe(String(process.pid));
  });

  it('is idempotent — leaves an already-correct registration untouched', () => {
    writeOwnDaemonPidFile();
    const before = fs.readFileSync(PID_FILE, 'utf-8');
    const mtimeBefore = fs.statSync(PID_FILE).mtimeMs;

    reassertOwnDaemonPidFile();

    expect(fs.readFileSync(PID_FILE, 'utf-8')).toBe(before);
    expect(fs.statSync(PID_FILE).mtimeMs).toBe(mtimeBefore);
  });

  it('keeps the ownership token so a recycled PID is not mistaken for the daemon', () => {
    reassertOwnDaemonPidFile();
    const [pidLine, token] = fs.readFileSync(PID_FILE, 'utf-8').split('\n');
    expect(pidLine).toBe(String(process.pid));
    // Platforms that can capture a start token must record it; those that
    // cannot (Windows) fall back to liveness alone and write no second line.
    expect(token ?? '').toBe(captureProcessStartToken(process.pid) ?? '');
  });
});
