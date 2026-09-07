/**
 * TRA-1112: the daemon dies mid-session and the client keeps its tools —
 * asserted against the *built* dist/proxy.js, not the source modules.
 *
 * tests/daemon/session-proxy-send-failure.test.ts already covers the routing
 * decision (promote on a failed send, replay the frame locally), but it mocks
 * `LocalBackend` away. That mock is exactly the part the shipped artifact has
 * to get right on its own: proxy.js reaches local mode through a *dynamic*
 * import of a separate bundle chunk (dist/local-backend.js), which is the one
 * code path in this file's module graph that pulls in better-sqlite3 and
 * web-tree-sitter. A chunk that fails to load there — a bundler change that
 * drops it, a native binding the runtime node cannot open — turns every
 * request after the daemon's death into `-32603 Backend send failed`, with the
 * mocked unit test still green. Observed while writing this: under a runtime
 * node that could not open one napi binding, the rescue threw and all three
 * follow-up calls came back as transport errors.
 *
 * Skips when dist/proxy.js is absent (pre-build CI steps), like the eval CLI
 * smoke test next door.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const PROXY = join(REPO_ROOT, 'dist', 'proxy.js');
const describeIfBuilt = existsSync(PROXY) ? describe : describe.skip;

/** Answers /health and /mcp with canned frames, until `kill()`. */
async function startFakeDaemon(): Promise<{ port: number; kill: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'healthy' }));
        return;
      }
      let msg: { id?: unknown; method?: string } = {};
      try {
        msg = JSON.parse(body);
      } catch {
        /* notification or garbage */
      }
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202).end();
        return;
      }
      const result =
        msg.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake-daemon', version: '0' },
            }
          : { servedBy: 'daemon', tools: [] };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    kill: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface RpcResponse {
  id: number;
  result?: { tools?: unknown[]; servedBy?: string };
  error?: { code: number; message: string };
}

/** Line-delimited JSON-RPC over the child's stdio, keyed by request id. */
function attachClient(child: ChildProcess) {
  const pending = new Map<number, (m: RpcResponse) => void>();
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: RpcResponse;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
  return {
    request(id: number, method: string, params: unknown = {}): Promise<RpcResponse> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60_000);
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method: string) {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
  };
}

describeIfBuilt('built proxy.js survives the daemon dying mid-session (TRA-1112)', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it('answers tools/list from local mode after the daemon goes away', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'trace-proxy-death-'));
    const project = join(sandbox, 'proj');
    const home = join(sandbox, 'home');
    mkdirSync(project);
    mkdirSync(home);
    writeFileSync(join(project, 'a.ts'), 'export function alpha() {\n  return 1;\n}\n');

    const daemon = await startFakeDaemon();
    const child = spawn(process.execPath, [PROXY, 'serve'], {
      cwd: project,
      env: {
        ...process.env,
        TRACE_MCP_HOME: home,
        TRACE_MCP_DAEMON_PORT: String(daemon.port),
        // Local mode has to come from the rescue path, not from a daemon this
        // test then races with.
        TRACE_MCP_NO_DAEMON: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanup = async () => {
      // Wait for the child to actually be gone before removing the sandbox.
      // `kill()` only posts the request — the process is still alive when it
      // returns — and this child's cwd IS `sandbox/proj`, which Windows locks
      // for as long as it lives. So teardown raced the exit and threw
      // `EBUSY: rmdir`, failing a test whose assertions had already passed.
      //
      // Retrying the rmSync does not fix it: the lock is held by a process,
      // not by a lingering handle, so the retries just burn their budget while
      // it is still running. Waiting is both the correct fix and the cheaper
      // one — on a healthy run the exit has usually already happened.
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      await daemon.kill().catch(() => {});
      rmSync(sandbox, { recursive: true, force: true });
    };

    const client = attachClient(child);
    const init = await client.request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'daemon-death-test', version: '0' },
    });
    expect(init.error).toBeUndefined();
    client.notify('notifications/initialized');

    // Proxy mode: the fake daemon is the one answering.
    const served = await client.request(2, 'tools/list');
    expect(served.result?.servedBy).toBe('daemon');

    await daemon.kill();

    // The frame that discovers the dead daemon must still come back as a real
    // answer, not as a transport error the agent reads as "server is gone".
    const afterDeath = await client.request(3, 'tools/list');
    expect(afterDeath.error).toBeUndefined();
    expect(afterDeath.result?.tools?.length ?? 0).toBeGreaterThan(0);

    // And the session stays usable, rather than degrading for one lucky call.
    const next = await client.request(4, 'tools/list');
    expect(next.error).toBeUndefined();
    expect(next.result?.tools?.length ?? 0).toBeGreaterThan(0);
  }, 120_000);
});
