/**
 * TRA-525 end-to-end guard: a spawn that loses the port race must not be able
 * to convince the watchdog that the *winning* daemon died.
 *
 * Field measurement (Nikolai's Mac, 2026-08-30): 724 `daemon restart` requests
 * in 18.7h — 38.8/h, peaking at 89/h. Sampling once a second for 5 minutes,
 * `daemon.pid` named a dead process in 24% of samples, and in one sample named
 * dead PID 38747 while live PID 36600 was serving traffic.
 *
 * Mechanism: `serve-http` registered its PID at the top of the action, before
 * binding. On `daemon restart` the new process claimed the registration, lost
 * the bind race to the still-running old daemon, and exited — leaving the file
 * naming a corpse. `isDaemonProcessAlive()` then reported "dead" about a daemon
 * that was working, which disarmed the TRA-421 guard whose entire job is to stop
 * the watchdog killing a busy daemon. Each kill replayed the same slow cold
 * start, which starved /health again. Self-sustaining loop.
 *
 * Reproduced deterministically here, with the same script that produced the
 * before/after on the fix:
 *   before — "daemon.pid after B died: 5896 (DEAD)", A (5779) alive and serving
 *   after  — "daemon.pid after B died: 4687 (alive)", A is 4687
 *
 * Spawns two real daemons on an isolated port and data dir; it never touches a
 * developer's live daemon on 3741.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

/** High enough to stay clear of the default 3741 and of other suites. */
const PORT = 3797;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-bindorder-'));
const PID_FILE = path.join(TMP_HOME, 'daemon.pid');

/**
 * This suite exercises the built `dist/cli.js`, and `pnpm test` has no build
 * step. A missing build is an obvious failure, but a *stale* one is worse: it
 * would run the pre-fix daemon and false-pass the very regression guarded here.
 * So skip unless the build is at least as new as the sources under test, and
 * say why.
 */
const SOURCES = ['src/cli.ts', 'src/daemon/lifecycle.ts'].map((p) => path.join(REPO_ROOT, p));
function buildIsCurrent(): boolean {
  if (!fs.existsSync(CLI)) return false;
  const builtAt = fs.statSync(CLI).mtimeMs;
  return SOURCES.every((src) => !fs.existsSync(src) || fs.statSync(src).mtimeMs <= builtAt);
}
const BUILD_CURRENT = buildIsCurrent();
if (!BUILD_CURRENT) {
  console.warn(
    `[pid-registration-bind-order] skipped: ${CLI} is missing or older than src/cli.ts — run \`pnpm run build\` first.`,
  );
}

const children: ChildProcess[] = [];

function spawnDaemon(): ChildProcess {
  const child = spawn(process.execPath, [CLI, 'serve-http', '--port', String(PORT)], {
    env: {
      ...process.env,
      TRACE_MCP_DATA_DIR: TMP_HOME,
      // Not launchd: keep the plist/KeepAlive path out of a unit test.
      TRACE_MCP_MANAGED_BY: 'test',
    },
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

/** The exact read the app watchdog performs (packages/app: isDaemonProcessAlive). */
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

async function waitForHealth(timeoutMs: number): Promise<{ pid?: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return (await res.json()) as { pid?: number };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
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

// Graceful shutdown closes every project DB and tears down watchers, which does
// not fit vitest's 10s default hook timeout — hence the explicit budget.
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  await Promise.all(children.map((c) => waitForExit(c, 25_000)));
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
}, 40_000);

describe.skipIf(!BUILD_CURRENT)(
  'daemon.pid is only claimed by the process that owns the port',
  () => {
    it('survives a second daemon losing the bind race and dying', async () => {
      const winner = spawnDaemon();
      const health = await waitForHealth(90_000);
      expect(health, 'first daemon never answered /health').not.toBeNull();
      expect(health?.pid).toBe(winner.pid);

      // The winner registered itself, and it did so as the process that listens.
      expect(readRegistration()).toEqual({ pid: winner.pid, alive: true });

      // The loser: same port, must exit rather than take over.
      const loser = spawnDaemon();
      const loserExit = await waitForExit(loser, 120_000);
      expect(loserExit, 'second daemon should have exited on EADDRINUSE').not.toBeNull();
      expect(loserExit).not.toBe(0);

      // Give any stray write a chance to land before asserting.
      await new Promise((r) => setTimeout(r, 1_000));

      // The whole point: after the loser died, the registration still names the
      // live winner. Before the fix this read `{ pid: <loser>, alive: false }`,
      // and the watchdog restarted a daemon that was serving fine.
      const after = readRegistration();
      expect(after.alive).toBe(true);
      expect(after.pid).toBe(winner.pid);
      expect(winner.exitCode).toBeNull();
    }, 240_000);
  },
);
