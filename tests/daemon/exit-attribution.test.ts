import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate TRACE_MCP_HOME before global.ts resolves it (once, at module load)
// so this never reads a live daemon's ~/.trace-mcp/daemon.pid.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-exitattr-'));
process.env.TRACE_MCP_DATA_DIR = TMP_HOME;

const { afterEach, describe, expect, it } = await import('vitest');
const { describeDaemonExitContext, processComm, writeOwnDaemonPidFile } = await import(
  '../../src/daemon/lifecycle.js'
);

const PID_FILE = path.join(TMP_HOME, 'daemon.pid');
const isWin = process.platform === 'win32';

/**
 * TRA-809: a SIGTERM carries no sender, so "who killed the daemon" has to be
 * reconstructed from the daemon's own context at shutdown. These are the three
 * causes that were indistinguishable in daemon.log.
 */
describe('describeDaemonExitContext (TRA-809)', () => {
  afterEach(() => {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* not every case writes it */
    }
    delete process.env.TRACE_MCP_MANAGED_BY;
  });

  it('reports missing when nothing owns daemon.pid', () => {
    const ctx = describeDaemonExitContext();
    expect(ctx.pidFileOwner).toBe('missing');
    expect(ctx.ppid).toBe(process.ppid);
    expect(ctx.managedBy).toBe('cli');
  });

  it('reports self for the registered daemon', () => {
    writeOwnDaemonPidFile();
    expect(describeDaemonExitContext().pidFileOwner).toBe('self');
  });

  it('names the other PID when a racing spawn stole the registration', () => {
    fs.writeFileSync(PID_FILE, '999999999\n');
    expect(describeDaemonExitContext().pidFileOwner).toBe(999_999_999);
  });

  it('surfaces how the daemon was launched', () => {
    process.env.TRACE_MCP_MANAGED_BY = 'launchd';
    expect(describeDaemonExitContext().managedBy).toBe('launchd');
  });

  it.skipIf(isWin)('resolves the parent process name', () => {
    expect(processComm(process.pid)).toBeTruthy();
    expect(processComm(-1)).toBeNull();
  });
});
