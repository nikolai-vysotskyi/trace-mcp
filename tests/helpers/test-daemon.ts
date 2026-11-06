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
 * Query /health from target daemon and strictly validate PID against both live PID and expected PID.
 * Fails closed on connection error, timeout, malformed response, or PID mismatch.
 */
export async function verifyDaemonTarget(target: {
  baseUrl: string;
  expectedPid?: number;
  livePid?: number | null;
  timeoutMs?: number;
}): Promise<number> {
  const url = new URL(target.baseUrl);
  const port = parseInt(url.port || '80', 10);

  if (port === 3741) {
    throw new Error(
      `[TEST ISOLATION GUARD] Target port 3741 is the live daemon port. ` +
        `Test fixtures must run against an isolated test daemon on a dedicated port (TRA-2946).`,
    );
  }

  const livePid = target.livePid !== undefined ? target.livePid : getLiveDaemonPid();

  let res: Response;
  try {
    res = await fetch(`${target.baseUrl}/health`, {
      signal: AbortSignal.timeout(target.timeoutMs ?? 2000),
    });
  } catch (err) {
    throw new Error(
      `[TEST ISOLATION GUARD] Failed to probe ${target.baseUrl}/health: ${String(err)}. ` +
        `Target daemon must be running and responsive before registration.`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `[TEST ISOLATION GUARD] Target daemon at ${target.baseUrl}/health returned HTTP ${res.status}. Expected HTTP 200.`,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      `[TEST ISOLATION GUARD] Malformed JSON response from ${target.baseUrl}/health. Fail closed.`,
    );
  }

  if (!data || typeof data !== 'object') {
    throw new Error(
      `[TEST ISOLATION GUARD] Non-object response from ${target.baseUrl}/health. Fail closed.`,
    );
  }

  const reportedPid = (data as { pid?: unknown }).pid;
  if (typeof reportedPid !== 'number' || !Number.isInteger(reportedPid) || reportedPid <= 0) {
    throw new Error(
      `[TEST ISOLATION GUARD] Target daemon at ${target.baseUrl}/health reported invalid or missing PID: ${String(reportedPid)}. Fail closed.`,
    );
  }

  // Check collision with live daemon PID
  if (livePid && reportedPid === livePid) {
    throw new Error(
      `[TEST ISOLATION GUARD] Target daemon PID ${reportedPid} matches the live daemon PID (${livePid}). ` +
        `Registration rejected: test fixtures must NEVER be registered in the live daemon (TRA-2946).`,
    );
  }

  // Check expected child PID match
  if (target.expectedPid && reportedPid !== target.expectedPid) {
    throw new Error(
      `[TEST ISOLATION GUARD] Target daemon at ${target.baseUrl} reported PID ${reportedPid}, ` +
        `which does not match expected child PID ${target.expectedPid}. Aborting registration to prevent targeting the wrong process (TRA-2946).`,
    );
  }

  return reportedPid;
}

/**
 * Assert that the target daemon is NOT the live developer daemon.
 * Rejects port 3741 or any daemon reporting a PID matching the live daemon PID.
 */
export async function assertNotLiveDaemon(target: {
  port?: number;
  baseUrl?: string;
  pid?: number;
  expectedPid?: number;
  livePid?: number | null;
  timeoutMs?: number;
}): Promise<void> {
  const urlStr = target.baseUrl ?? null;
  const port = target.port ?? (urlStr ? parseInt(new URL(urlStr).port || '80', 10) : undefined);

  if (port === 3741) {
    throw new Error(
      `[TEST ISOLATION GUARD] Target port 3741 is the live daemon port. ` +
        `Test fixtures must run against an isolated test daemon on a dedicated port (TRA-2946).`,
    );
  }

  const livePid = target.livePid !== undefined ? target.livePid : getLiveDaemonPid();

  // If testing offline PID matching directly
  if (target.pid) {
    if (livePid && target.pid === livePid) {
      throw new Error(
        `[TEST ISOLATION GUARD] Target daemon PID ${target.pid} matches the live daemon PID (${livePid}). ` +
          `Registration rejected: test fixtures must NEVER be registered in the live daemon (TRA-2946).`,
      );
    }
    if (target.expectedPid && target.pid !== target.expectedPid) {
      throw new Error(
        `[TEST ISOLATION GUARD] Target daemon reported PID ${target.pid}, ` +
          `which does not match expected child PID ${target.expectedPid}. Aborting registration (TRA-2946).`,
      );
    }
  }

  // If a live URL is provided, probe and verify it directly
  if (urlStr) {
    await verifyDaemonTarget({
      baseUrl: urlStr,
      expectedPid: target.expectedPid,
      livePid,
      timeoutMs: target.timeoutMs,
    });
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
 * Wait for a daemon's /health endpoint to respond HTTP 200 with matching expected PID.
 */
export async function waitForDaemonHealth(
  baseUrl: string,
  options: { expectedPid?: number; timeoutMs?: number } = {},
): Promise<{ pid?: number; status?: string }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as { pid?: number; status?: string };
        if (
          typeof data.pid === 'number' &&
          (!options.expectedPid || data.pid === options.expectedPid)
        ) {
          return data;
        }
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Daemon at ${baseUrl} did not become ready with expected PID within ${timeoutMs}ms`,
  );
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
  teardownProject(
    projectRoot: string,
    opts?: { verifyRegistry?: boolean; stopDaemon?: boolean; timeoutMs?: number },
  ): Promise<void>;
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
  fs.writeFileSync(
    path.join(dataDir, 'registry.json'),
    JSON.stringify({ version: 1, projects: {} }, null, 2),
  );

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
  await waitForDaemonHealth(baseUrl, {
    expectedPid: childPid,
    timeoutMs: options.timeoutMs ?? 15_000,
  });

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
        child: opts.stopDaemon ? child : undefined,
        timeoutMs: opts.timeoutMs,
      });
    },
  };

  return instance;
}

/**
 * Register a test project against a test daemon, enforcing PID and port isolation guards.
 * Always probes /health immediately prior to registration and compares PID.
 */
export async function registerTestProject(
  baseUrl: string,
  projectRoot: string,
  opts?: { port?: number; expectedPid?: number; livePid?: number | null },
): Promise<{ status: string; project: string }> {
  // Always probe /health immediately before POST; verifies PID against livePid and expectedPid
  await verifyDaemonTarget({
    baseUrl,
    expectedPid: opts?.expectedPid,
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

export interface TeardownProjectOptions {
  dataDir?: string;
  timeoutMs?: number;
  child?: ChildProcess;
  expectRegistryFile?: boolean;
}

/**
 * Verifiable teardown of a test project:
 * 1. Calls DELETE /api/projects?project=<root> and verifies watcherUnsubscribed barrier
 * 2. Confirms absence in GET /api/projects with strict schema validation
 * 3. Confirms absence in registry.json with strict schema validation
 * 4. Awaits child process termination if child process is provided (guaranteeing kernel-level watcher/fd closure)
 */
export async function teardownTestProject(
  baseUrl: string,
  projectRoot: string,
  opts: TeardownProjectOptions = {},
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

  if (delRes.ok) {
    let delJson: unknown;
    try {
      delJson = await delRes.json();
    } catch {
      // ignore JSON parse error on non-json DELETE responses
    }
    if (delJson && typeof delJson === 'object') {
      const parsed = delJson as { watcherUnsubscribed?: unknown };
      if (parsed.watcherUnsubscribed === false) {
        throw new Error(
          `Watcher teardown barrier failed: watcher unsubscribe did not settle cleanly for ${projectRoot}`,
        );
      }
    }
  }

  // 2. Verify absence in GET /api/projects with strict validation
  const timeoutMs = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  let absentInApi = false;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const getRes = await fetch(`${baseUrl}/api/projects`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!getRes.ok) {
        throw new Error(`GET /api/projects failed with HTTP ${getRes.status}`);
      }
      let rawJson: unknown;
      try {
        rawJson = await getRes.json();
      } catch (err) {
        throw new Error(`GET /api/projects returned invalid JSON: ${String(err)}`);
      }

      if (!rawJson || typeof rawJson !== 'object') {
        throw new Error(`GET /api/projects response is not an object`);
      }

      const projects = (rawJson as { projects?: unknown }).projects;
      if (!Array.isArray(projects)) {
        throw new Error(`Malformed /api/projects response: 'projects' field is not an array`);
      }

      const found = projects.some((p: unknown) => {
        if (!p || typeof p !== 'object') return false;
        const r = (p as { root?: unknown }).root;
        return r === projectRoot || r === canonicalRoot;
      });

      if (!found) {
        absentInApi = true;
        break;
      }
    } catch (err) {
      lastError = err as Error;
      if (
        lastError.message.includes('not an array') ||
        lastError.message.includes('invalid JSON') ||
        lastError.message.includes('not an object')
      ) {
        throw lastError;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!absentInApi) {
    if (lastError) throw lastError;
    throw new Error(`Project ${projectRoot} was not cleanly removed from GET /api/projects`);
  }

  // 3. Verify absence in registry.json with strict schema validation
  if (opts.dataDir) {
    const registryPath = path.join(opts.dataDir, 'registry.json');
    if (opts.expectRegistryFile && !fs.existsSync(registryPath)) {
      throw new Error(
        `Expected registry.json at ${registryPath} does not exist or was unexpectedly removed`,
      );
    }

    if (fs.existsSync(registryPath)) {
      let raw: string;
      try {
        raw = fs.readFileSync(registryPath, 'utf-8');
      } catch (err) {
        throw new Error(`Failed to read registry.json at ${registryPath}: ${String(err)}`);
      }

      let reg: unknown;
      try {
        reg = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Malformed registry.json at ${registryPath}: ${String(err)}`);
      }

      if (!reg || typeof reg !== 'object') {
        throw new Error(`Malformed registry.json at ${registryPath}: content is not an object`);
      }

      const projectsObj = (reg as { projects?: unknown }).projects;
      if (projectsObj !== undefined) {
        if (!projectsObj || typeof projectsObj !== 'object' || Array.isArray(projectsObj)) {
          throw new Error(
            `Malformed registry.json at ${registryPath}: 'projects' field is not an object`,
          );
        }

        const projectMap = projectsObj as Record<string, unknown>;
        if (projectMap[projectRoot] !== undefined || projectMap[canonicalRoot] !== undefined) {
          throw new Error(
            `Project ${projectRoot} still recorded in registry.json at ${registryPath}`,
          );
        }

        for (const [key, entry] of Object.entries(projectMap)) {
          if (key === projectRoot || key === canonicalRoot) {
            throw new Error(
              `Project ${projectRoot} still recorded as key ${key} in registry.json at ${registryPath}`,
            );
          }
          if (entry && typeof entry === 'object') {
            const rootInEntry = (entry as { root?: unknown }).root;
            if (rootInEntry === projectRoot || rootInEntry === canonicalRoot) {
              throw new Error(
                `Project ${projectRoot} still referenced in entry '${key}' in registry.json at ${registryPath}`,
              );
            }
          }
        }
      }
    }
  }

  // 4. Watcher completion barrier: for isolated test daemons, await child exit
  if (opts.child) {
    await stopChildProcess(opts.child);
  }
}
