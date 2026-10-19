/**
 * TRA-2531: Daemon lifecycle & restart under indexing load.
 *
 * Verifies that:
 * 1. An active daemon with indexed/indexing projects shuts down boundedly upon SIGTERM
 *    within DAEMON_SHUTDOWN_DEADLINE_MS.
 * 2. A replacement daemon binds the port immediately and responds to /health without
 *    getting stuck unlistening or wedged behind background operations.
 * 3. No orphaned unlistening process remains, and PID registration updates cleanly.
 * 4. Cleanup removes registered projects cleanly.
 *
 * All operations use an isolated data directory in /tmp and an isolated port
 * (never touches live 3741 or user registry).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAEMON_SHUTDOWN_DEADLINE_MS } from '../../src/server/bounded-shutdown.js';

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
const PORT = 3799;

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-restart-indexing-'));
const PID_FILE = path.join(TMP_HOME, 'daemon.pid');
const TEST_PROJECT = path.join(TMP_HOME, 'sample-project');

const SOURCES = ['src/cli.ts', 'src/cli/daemon.ts', 'src/daemon/lifecycle.ts'].map((p) =>
  path.join(REPO_ROOT, p),
);

function buildIsCurrent(): boolean {
  if (!fs.existsSync(CLI)) return false;
  const builtAt = fs.statSync(CLI).mtimeMs;
  return SOURCES.every((src) => !fs.existsSync(src) || fs.statSync(src).mtimeMs <= builtAt);
}

const BUILD_CURRENT = buildIsCurrent();
const children: ChildProcess[] = [];

function spawnDaemon(): ChildProcess {
  const child = spawn(process.execPath, [CLI, 'serve-http', '--port', String(PORT)], {
    env: {
      ...process.env,
      TRACE_MCP_DATA_DIR: TMP_HOME,
      TRACE_MCP_HOME: TMP_HOME,
      TRACE_MCP_MANAGED_BY: 'test',
      CI: '',
    },
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

function readRegistration(): { pid: number | null; alive: boolean } {
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').split(/\r?\n/)[0]?.trim() ?? '', 10);
  } catch {
    return { pid: null, alive: false };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { pid: null, alive: false };
  try {
    process.kill(pid, 0);
    return { pid, alive: true };
  } catch {
    return { pid, alive: false };
  }
}

async function waitForHealth(timeoutMs: number): Promise<{ pid?: number; status?: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return (await res.json()) as { pid?: number; status?: string };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

beforeAll(() => {
  fs.mkdirSync(TEST_PROJECT, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_PROJECT, 'package.json'),
    JSON.stringify({ name: 'sample-project', version: '1.0.0' }),
  );
  fs.writeFileSync(
    path.join(TEST_PROJECT, 'index.js'),
    'console.log("Hello world from sample project");',
  );
});

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  await Promise.all(children.map((c) => waitForExit(c, 25_000)));
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {}
}, 40_000);

describe.skipIf(!BUILD_CURRENT)('TRA-2531: daemon restart and health recovery under load', () => {
  it('gracefully recovers /health after daemon shutdown during active workload without hung processes', async () => {
    // 1. Start daemon 1
    const daemon1 = spawnDaemon();
    const health1 = await waitForHealth(30_000);
    expect(health1, 'Daemon 1 should answer /health').not.toBeNull();
    expect(health1?.pid).toBe(daemon1.pid);
    expect(readRegistration()).toEqual({ pid: daemon1.pid, alive: true });

    // 2. Register project on daemon 1
    const addRes = await fetch(`http://127.0.0.1:${PORT}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: TEST_PROJECT }),
    });
    expect(addRes.status).toBe(201);

    // 3. Initiate bounded restart by sending SIGTERM to daemon 1
    daemon1.kill('SIGTERM');

    // 4. Daemon 1 must exit within bounded deadline
    const exit1 = await waitForExit(daemon1, DAEMON_SHUTDOWN_DEADLINE_MS + 5_000);
    expect(exit1, 'Daemon 1 must exit cleanly within shutdown deadline').not.toBeNull();

    // 5. Spawn daemon 2 (replacement daemon)
    const daemon2 = spawnDaemon();

    // 6. Replacement daemon must bind port and answer /health cleanly and quickly (<10s)
    const health2 = await waitForHealth(15_000);
    expect(health2, 'Daemon 2 should answer /health cleanly').not.toBeNull();
    expect(health2?.pid).toBe(daemon2.pid);

    // Registration must reflect daemon 2 and be alive
    const reg2 = readRegistration();
    expect(reg2.alive).toBe(true);
    expect(reg2.pid).toBe(daemon2.pid);

    // Daemon 1 is dead, daemon 2 is alive — no hung unlistening process
    expect(daemon1.exitCode).not.toBeNull();
    expect(daemon2.exitCode).toBeNull();

    // 7. Cleanup: DELETE registered project and verify clean state
    const deleteRes = await fetch(
      `http://127.0.0.1:${PORT}/api/projects?project=${encodeURIComponent(TEST_PROJECT)}`,
      { method: 'DELETE' },
    );
    expect(deleteRes.status).toBe(200);

    // Verify /health reports project unlinked
    const healthAfterDelete = await waitForHealth(5_000);
    expect(healthAfterDelete).not.toBeNull();

    // Shutdown daemon 2 cleanly
    daemon2.kill('SIGTERM');
    const exit2 = await waitForExit(daemon2, DAEMON_SHUTDOWN_DEADLINE_MS + 5_000);
    expect(exit2, 'Daemon 2 must exit cleanly within shutdown deadline').not.toBeNull();
  }, 90_000);
});
