/**
 * Test daemon isolation helper and fixture harness (TRA-2946).
 *
 * Guarantees that automated and manual QA tests:
 * 1. Run against dedicated, ephemeral test daemons with isolated ports and data directories.
 * 2. Never connect to or register test fixtures in the live developer daemon (:3741 / ~/.trace).
 * 3. Enforce verifiable teardown (DELETE /api/projects, registry absence, watcher stop)
 *    before filesystem removal, preventing event-loop stalls and ENOENT storms.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Read the PID of the live daemon currently running on this machine, if any.
 * Checks known default state directories and verifies process liveness.
 */
export function getLiveDaemonPid(): number | null {
  const candidates: string[] = [];

  // When running under Vitest with isolate-home.ts, TRACE_MCP_REAL_DATA_DIR
  // points to the user's real ~/.trace or ~/.trace-mcp data directory.
  if (process.env.TRACE_MCP_REAL_DATA_DIR) {
    candidates.push(path.join(process.env.TRACE_MCP_REAL_DATA_DIR, 'daemon.pid'));
  }

  const home = os.homedir();
  if (home) {
    candidates.push(path.join(home, '.trace', 'daemon.pid'));
    candidates.push(path.join(home, '.trace-mcp', 'daemon.pid'));
  }

  for (const pidFile of candidates) {
    try {
      if (!fs.existsSync(pidFile)) continue;
      const raw = fs.readFileSync(pidFile, 'utf-8').trim();
      const firstLine = raw.split(/\r?\n/)[0]?.trim();
      const pid = parseInt(firstLine ?? '', 10);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // Liveness check
          return pid;
        } catch {
          // Process not running
        }
      }
    } catch {
      /* ignore read errors */
    }
  }

  return null;
}

/**
 * Assert that the target daemon is NOT the live developer daemon.
 * Rejects port 3741 or any daemon reporting a PID matching the live daemon PID.
 */
export async function assertNotLiveDaemon(target: {
  port?: number;
  baseUrl?: string;
  pid?: number;
  livePid?: number | null;
}): Promise<void> {
  const urlStr = target.baseUrl ?? (target.port ? `http://127.0.0.1:${target.port}` : null);
  const parsedPort = urlStr ? parseInt(new URL(urlStr).port || '80', 10) : target.port;

  if (parsedPort === 3741) {
    throw new Error(
      `[TEST ISOLATION GUARD] Target port 3741 is the live daemon port. ` +
        `Test fixtures must run against an isolated test daemon on a dedicated port (TRA-2946).`,
    );
  }

  const livePid = target.livePid !== undefined ? target.livePid : getLiveDaemonPid();

  let reportedPid = target.pid;
  if (!reportedPid && urlStr) {
    try {
      const res = await fetch(`${urlStr}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as { pid?: number };
        reportedPid = data.pid;
      }
    } catch {
      /* connection or health check failed */
    }
  }

  if (livePid && reportedPid && livePid === reportedPid) {
    throw new Error(
      `[TEST ISOLATION GUARD] Target daemon PID ${reportedPid} matches the live daemon PID (${livePid}). ` +
        `Registration rejected: test fixtures must NEVER be registered in the live daemon (TRA-2946).`,
    );
  }
}

/**
 * Allocate a free TCP port, ensuring it is not 3741.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to get free port')));
        return;
      }
      const port = addr.port;
      srv.close(() => {
        if (port === 3741) {
          // Collision with live port: retry
          resolve(getFreePort());
        } else {
          resolve(port);
        }
      });
    });
    srv.on('error', reject);
  });
}

/**
 * Wait for a daemon's /health endpoint to respond HTTP 200.
 */
export async function waitForDaemonHealth(
  baseUrl: string,
  timeoutMs = 15_000,
): Promise<{ pid?: number; status?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        return (await res.json()) as { pid?: number; status?: string };
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Daemon at ${baseUrl} did not become ready within ${timeoutMs}ms`);
}

/**
 * Stop a spawned child process reliably (SIGTERM with fallback to SIGKILL).
 */
export function stopChildProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        child.kill('SIGKILL');
      }
      resolve();
      return;
    }

    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 2000);
  });
}

export interface TestDaemonInstance {
  port: number;
  baseUrl: string;
  dataDir: string;
  pid: number;
  child: ChildProcess;
  stop(): Promise<void>;
  registerProject(projectRoot: string): Promise<{ status: string; project: string }>;
  teardownProject(projectRoot: string, opts?: { verifyRegistry?: boolean }): Promise<void>;
}

/**
 * Spawn a fully isolated test daemon with an explicit port and throwaway data dir.
 */
export async function spawnTestDaemon(
  options: { port?: number; dataDir?: string; timeoutMs?: number } = {},
): Promise<TestDaemonInstance> {
  const repoRoot = path.resolve(__dirname, '../..');
  const cli = path.join(repoRoot, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) {
    throw new Error(`dist/cli.js does not exist; run pnpm build before spawning test daemon`);
  }

  const port = options.port ?? (await getFreePort());
  if (port === 3741) {
    throw new Error('Refusing to spawn test daemon on live port 3741');
  }

  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-daemon-'));
  fs.mkdirSync(path.join(dataDir, 'index'), { recursive: true });

  const child = spawn(process.execPath, [cli, 'serve-http', '--port', String(port)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TRACE_MCP_ALLOW_EPHEMERAL_DAEMON: '1',
      TRACE_MCP_DATA_DIR: dataDir,
      TRACE_MCP_HOME: dataDir,
      TRACE_MCP_MANAGED_BY: 'test',
      CI: '',
    },
    stdio: 'ignore',
  });

  const childPid = child.pid;
  if (!childPid) {
    throw new Error(`Failed to spawn test daemon process on port ${port}`);
  }

  const livePid = getLiveDaemonPid();
  if (livePid && childPid === livePid) {
    child.kill('SIGKILL');
    throw new Error(`Spawned test daemon PID ${childPid} collides with live daemon PID ${livePid}`);
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForDaemonHealth(baseUrl, options.timeoutMs ?? 15_000);

  const instance: TestDaemonInstance = {
    port,
    baseUrl,
    dataDir,
    pid: childPid,
    child,
    async stop() {
      await stopChildProcess(child);
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
    async registerProject(projectRoot: string) {
      return registerTestProject(baseUrl, projectRoot, {
        port,
        expectedPid: childPid,
        livePid,
      });
    },
    async teardownProject(projectRoot: string, opts = {}) {
      return teardownTestProject(baseUrl, projectRoot, {
        dataDir: opts.verifyRegistry !== false ? dataDir : undefined,
      });
    },
  };

  return instance;
}

/**
 * Register a test project against a test daemon, enforcing PID and port isolation guards.
 */
export async function registerTestProject(
  baseUrl: string,
  projectRoot: string,
  opts?: { port?: number; expectedPid?: number; livePid?: number | null },
): Promise<{ status: string; project: string }> {
  await assertNotLiveDaemon({
    baseUrl,
    port: opts?.port,
    pid: opts?.expectedPid,
    livePid: opts?.livePid,
  });

  const res = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: projectRoot }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to register test project ${projectRoot} at ${baseUrl}: HTTP ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as { status: string; project: string };
}

/**
 * Verifiable teardown of a test project:
 * 1. Calls DELETE /api/projects?project=<root>
 * 2. Confirms absence in GET /api/projects
 * 3. Confirms absence in registry.json (if dataDir is provided)
 * 4. Ensures watcher teardown has completed before the caller removes files from disk.
 */
export async function teardownTestProject(
  baseUrl: string,
  projectRoot: string,
  opts: { dataDir?: string; timeoutMs?: number } = {},
): Promise<void> {
  let canonicalRoot = projectRoot;
  try {
    if (fs.existsSync(projectRoot)) {
      canonicalRoot = fs.realpathSync(projectRoot);
    }
  } catch {
    /* keep projectRoot */
  }

  // 1. Send DELETE /api/projects
  const delUrl = `${baseUrl}/api/projects?project=${encodeURIComponent(projectRoot)}`;
  const delRes = await fetch(delUrl, { method: 'DELETE' });
  if (!delRes.ok && delRes.status !== 404) {
    const text = await delRes.text();
    throw new Error(`DELETE /api/projects failed: HTTP ${delRes.status}: ${text}`);
  }

  // 2. Verify absence in GET /api/projects
  const timeoutMs = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  let absentInApi = false;
  while (Date.now() < deadline) {
    try {
      const getRes = await fetch(`${baseUrl}/api/projects`);
      if (getRes.ok) {
        const json = (await getRes.json()) as { projects?: Array<{ root: string }> };
        const found = json.projects?.some(
          (p) => p.root === projectRoot || p.root === canonicalRoot,
        );
        if (!found) {
          absentInApi = true;
          break;
        }
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!absentInApi) {
    throw new Error(`Project ${projectRoot} was not cleanly removed from GET /api/projects`);
  }

  // 3. Verify absence in registry.json
  if (opts.dataDir) {
    const registryPath = path.join(opts.dataDir, 'registry.json');
    if (fs.existsSync(registryPath)) {
      try {
        const raw = fs.readFileSync(registryPath, 'utf-8');
        const reg = JSON.parse(raw) as { projects?: Record<string, unknown> };
        if (reg.projects && (reg.projects[projectRoot] || reg.projects[canonicalRoot])) {
          throw new Error(
            `Project ${projectRoot} still recorded in registry.json at ${registryPath}`,
          );
        }
      } catch (err) {
        if ((err as Error).message.includes('still recorded in registry.json')) {
          throw err;
        }
      }
    }
  }

  // 4. Teardown watcher settling delay to guarantee FSEvents unsubscribe has drained
  await new Promise((r) => setTimeout(r, 150));
}
