/**
 * TRA-2946: Test daemon isolation and PID guard tests.
 *
 * Verifies that:
 * 1. Client-side isolation guards reject port 3741 and any PID matching the live daemon.
 * 2. Pre-POST health probes verify target daemon PID and abort with zero POSTs on PID mismatch.
 * 3. Server-side dangerous root check rejects temporary test fixtures on a live daemon,
 *    while never rejecting permanent repositories with fixture-like names.
 * 4. Teardown validates API schema and registry integrity, failing closed on malformed data.
 * 5. An isolated test daemon with dedicated port & data dir registers, queries, and cleanly
 *    tears down a test project without touching the live daemon or registry.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  isDangerousProjectRoot,
  isTestFixturePath,
  isUnderTempDirectory,
} from '../../src/dangerous-root.js';
import {
  assertNotLiveDaemon,
  getFreePort,
  getLiveDaemonPid,
  registerTestProject,
  spawnTestDaemon,
  stopChildProcess,
  teardownTestProject,
  type TestDaemonInstance,
} from '../helpers/test-daemon.js';

describe('TRA-2946: Test daemon isolation and live daemon protection', () => {
  describe('Client isolation guards and pre-POST health validation', () => {
    it('refuses port 3741 explicitly', async () => {
      await expect(assertNotLiveDaemon({ port: 3741 })).rejects.toThrow(
        /Target port 3741 is the live daemon port/,
      );

      await expect(assertNotLiveDaemon({ baseUrl: 'http://127.0.0.1:3741' })).rejects.toThrow(
        /Target port 3741 is the live daemon port/,
      );
    });

    it('refuses any daemon whose PID matches the live daemon PID', async () => {
      const mockLivePid = 999999;
      await expect(
        assertNotLiveDaemon({
          port: 3799,
          pid: mockLivePid,
          livePid: mockLivePid,
        }),
      ).rejects.toThrow(/matches the live daemon PID/);
    });

    it('registerTestProject fails client-side before sending requests if target is live port 3741', async () => {
      await expect(
        registerTestProject('http://127.0.0.1:3741', '/tmp/trace-mcp-tra2941-isolated'),
      ).rejects.toThrow(/Target port 3741 is the live daemon port/);
    });

    it('permits non-3741 port with non-colliding PID in offline checks', async () => {
      await expect(
        assertNotLiveDaemon({
          port: 3888,
          pid: 12345,
          expectedPid: 12345,
          livePid: 54321,
        }),
      ).resolves.toBeUndefined();
    });

    it('pre-POST probe detects PID mismatch against mock server and sends zero POST requests', async () => {
      let postCount = 0;
      let healthCount = 0;

      const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
          healthCount++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', pid: 9999 })); // Reports PID 9999
          return;
        }
        if (req.method === 'POST' && req.url === '/api/projects') {
          postCount++;
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'added' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      const mockUrl = `http://127.0.0.1:${addr.port}`;

      try {
        await expect(
          registerTestProject(mockUrl, '/tmp/trace-mcp-tra2941-isolated', {
            expectedPid: 1111, // Expects PID 1111, server reports 9999
          }),
        ).rejects.toThrow(/does not match expected child PID 1111/);

        expect(healthCount).toBe(1);
        expect(postCount).toBe(0); // Strictly ZERO POSTs sent
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('Server-side fixture detection and dangerous root guard (isDangerousProjectRoot)', () => {
    it('detects test fixture naming patterns inside temporary storage', () => {
      expect(isTestFixturePath('/tmp/trace-mcp-tra2941-isolated')).toBe(true);
      expect(isTestFixturePath('/private/tmp/trace-mcp-tra2941-isolated')).toBe(true);
      expect(isTestFixturePath('/tmp/trace-mcp-test-home-12345')).toBe(true);
      expect(isTestFixturePath('/tmp/trace-restart-indexing-abc')).toBe(true);
      expect(isTestFixturePath('/tmp/tmcp-packaged-lab-xyz')).toBe(true);
      expect(isTestFixturePath('/tmp/truncation-boundary-2941-test')).toBe(true);
      expect(isTestFixturePath('/var/folders/xx/yy/T/trace-mcp-tra2941-isolated')).toBe(true);
    });

    it('never rejects permanent directories outside temporary storage even with fixture-like names', () => {
      // User project with "test" or "fixture" in the name in permanent workspace
      const permanentWorkspaces = [
        '/Users/nikolai/Projects/trace-test-app',
        '/Users/nikolai/PhpstormProjects/trace-mcp-tra2941-isolated',
        '/home/alice/trace-test-fixture',
        '/Users/bob/dev/tmcp-packaged-suite',
      ];

      for (const permPath of permanentWorkspaces) {
        expect(isUnderTempDirectory(permPath)).toBe(false);
        expect(isTestFixturePath(permPath)).toBe(false);
      }
    });

    it('rejects test fixture root on live daemon when test context is disabled', () => {
      const origManagedBy = process.env.TRACE_MCP_MANAGED_BY;
      const origVitest = process.env.VITEST;
      const origNodeEnv = process.env.NODE_ENV;
      const origAllow = process.env.TRACE_MCP_ALLOW_TEST_ROOTS;

      try {
        delete process.env.TRACE_MCP_MANAGED_BY;
        delete process.env.VITEST;
        delete process.env.NODE_ENV;
        delete process.env.TRACE_MCP_ALLOW_TEST_ROOTS;

        const reason = isDangerousProjectRoot('/tmp/trace-mcp-tra2941-isolated');
        expect(reason).toBe('test fixture path on live daemon');

        // But permanent path with similar name is NOT rejected
        const permReason = isDangerousProjectRoot('/Users/nikolai/Projects/trace-test-app');
        expect(permReason).toBeNull();
      } finally {
        if (origManagedBy !== undefined) process.env.TRACE_MCP_MANAGED_BY = origManagedBy;
        if (origVitest !== undefined) process.env.VITEST = origVitest;
        if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
        if (origAllow !== undefined) process.env.TRACE_MCP_ALLOW_TEST_ROOTS = origAllow;
      }
    });

    it('allows test fixture root when TRACE_MCP_MANAGED_BY=test', () => {
      const origManagedBy = process.env.TRACE_MCP_MANAGED_BY;
      try {
        process.env.TRACE_MCP_MANAGED_BY = 'test';
        const reason = isDangerousProjectRoot('/tmp/trace-mcp-tra2941-isolated');
        expect(reason).toBeNull();
      } finally {
        if (origManagedBy !== undefined) process.env.TRACE_MCP_MANAGED_BY = origManagedBy;
      }
    });
  });

  describe('Teardown protocol validation and error handling', () => {
    it('fails closed when GET /api/projects returns a malformed response missing projects array', async () => {
      const server = http.createServer((req, res) => {
        if (req.method === 'DELETE') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'removed' }));
          return;
        }
        if (req.method === 'GET' && req.url === '/api/projects') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' })); // Missing 'projects' array
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      const mockUrl = `http://127.0.0.1:${addr.port}`;

      try {
        await expect(
          teardownTestProject(mockUrl, '/tmp/sample-project', { timeoutMs: 500 }),
        ).rejects.toThrow(/'projects' field is not an array/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('fails closed when registry.json contains corrupt syntax', async () => {
      const server = http.createServer((req, res) => {
        if (req.method === 'DELETE') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'removed' }));
          return;
        }
        if (req.method === 'GET' && req.url === '/api/projects') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ projects: [] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      const mockUrl = `http://127.0.0.1:${addr.port}`;

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-reg-'));
      fs.writeFileSync(path.join(tmpDir, 'registry.json'), '{ corrupt json syntax ...');

      try {
        await expect(
          teardownTestProject(mockUrl, '/tmp/sample-project', {
            dataDir: tmpDir,
            timeoutMs: 500,
          }),
        ).rejects.toThrow(/Malformed registry\.json/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('fails closed when DELETE /api/projects reports watcherUnsubscribed is false', async () => {
      const server = http.createServer((req, res) => {
        if (req.method === 'DELETE') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'removed', watcherUnsubscribed: false }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      const mockUrl = `http://127.0.0.1:${addr.port}`;

      try {
        await expect(
          teardownTestProject(mockUrl, '/tmp/sample-project', { timeoutMs: 500 }),
        ).rejects.toThrow(
          /Watcher teardown barrier failed: watcher unsubscribe did not settle cleanly/,
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('fails closed when dataDir is provided but registry.json does not exist', async () => {
      const server = http.createServer((req, res) => {
        if (req.method === 'DELETE') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'removed', watcherUnsubscribed: true }));
          return;
        }
        if (req.method === 'GET' && req.url === '/api/projects') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ projects: [] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      const mockUrl = `http://127.0.0.1:${addr.port}`;

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-reg-'));

      try {
        await expect(
          teardownTestProject(mockUrl, '/tmp/sample-project', {
            dataDir: tmpDir,
            expectRegistryFile: true,
            timeoutMs: 500,
          }),
        ).rejects.toThrow(
          /Expected registry\.json at .* does not exist or was unexpectedly removed/,
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('fails closed when registry.json projects field is not an object', async () => {
      const server = http.createServer((req, res) => {
        if (req.method === 'DELETE') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'removed' }));
          return;
        }
        if (req.method === 'GET' && req.url === '/api/projects') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ projects: [] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      const mockUrl = `http://127.0.0.1:${addr.port}`;

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-reg-'));
      fs.writeFileSync(path.join(tmpDir, 'registry.json'), '{"version": 1, "projects": "invalid"}');

      try {
        await expect(
          teardownTestProject(mockUrl, '/tmp/sample-project', {
            dataDir: tmpDir,
            timeoutMs: 500,
          }),
        ).rejects.toThrow(/'projects' field is not an object/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('fails closed and rejects when child process does not exit within timeoutMs in stopChildProcess', async () => {
      // Mock hung ChildProcess that does not emit 'exit' or 'close'
      const hungChild = new EventEmitter() as unknown as ChildProcess;
      hungChild.pid = 999991;
      hungChild.exitCode = null;
      hungChild.signalCode = null;
      hungChild.kill = vi.fn().mockReturnValue(true);

      await expect(stopChildProcess(hungChild, 100)).rejects.toThrow(
        /Failed to terminate child process PID 999991 within 100ms/,
      );
    });
  });

  describe('Isolated test daemon lifecycle and verifiable teardown', () => {
    let daemon: TestDaemonInstance | null = null;
    let fixtureDir: string;

    beforeAll(async () => {
      const port = await getFreePort();
      daemon = await spawnTestDaemon({ port });
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-fixture-2946-'));
      fs.mkdirSync(path.join(fixtureDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(fixtureDir, 'src', 'index.ts'), 'export const testValue = 42;\n');
    });

    afterAll(async () => {
      if (daemon) {
        await daemon.stop();
      }
      try {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });

    it('isolated test daemon runs on a non-3741 port and has an independent PID', () => {
      expect(daemon).not.toBeNull();
      expect(daemon!.port).not.toBe(3741);
      const livePid = getLiveDaemonPid();
      if (livePid) {
        expect(daemon!.pid).not.toBe(livePid);
      }
    });

    it('registers project on isolated test daemon and performs verifiable teardown', async () => {
      expect(daemon).not.toBeNull();

      // 1. Register project
      const reg = await daemon!.registerProject(fixtureDir);
      expect(reg.status).toBe('added');

      // 2. Verify project is listed in /api/projects
      const listRes = await fetch(`${daemon!.baseUrl}/api/projects`);
      expect(listRes.ok).toBe(true);
      const listJson = (await listRes.json()) as { projects: Array<{ root: string }> };
      const canonical = fs.realpathSync(fixtureDir);
      expect(listJson.projects.some((p) => p.root === fixtureDir || p.root === canonical)).toBe(
        true,
      );

      // 3. Teardown project
      await daemon!.teardownProject(fixtureDir);

      // 4. Verify project is absent from /api/projects
      const verifyRes = await fetch(`${daemon!.baseUrl}/api/projects`);
      const verifyJson = (await verifyRes.json()) as { projects: Array<{ root: string }> };
      expect(verifyJson.projects.some((p) => p.root === fixtureDir || p.root === canonical)).toBe(
        false,
      );

      // 5. Verify registry.json does not retain the project
      const regPath = path.join(daemon!.dataDir, 'registry.json');
      if (fs.existsSync(regPath)) {
        const regRaw = fs.readFileSync(regPath, 'utf-8');
        expect(regRaw).not.toContain(fixtureDir);
        expect(regRaw).not.toContain(canonical);
      }
    });

    it('enforces child daemon process exit barrier during teardown before fixture removal', async () => {
      const port = await getFreePort();
      const localDaemon = await spawnTestDaemon({ port });
      const localFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-barrier-fixture-'));
      fs.mkdirSync(path.join(localFixture, 'src'), { recursive: true });
      fs.writeFileSync(path.join(localFixture, 'src', 'index.ts'), 'export const barrier = 1;\n');

      try {
        await localDaemon.registerProject(localFixture);

        // Teardown with stopDaemon: true awaits child process exit before resolving
        await localDaemon.teardownProject(localFixture, { stopDaemon: true });

        // Verify the child process is genuinely terminated (exit confirmed by kernel)
        expect(localDaemon.child.exitCode !== null || localDaemon.child.signalCode !== null).toBe(
          true,
        );

        // Now safe to delete fixture files without risking watcher ENOENT storms
        expect(() => {
          fs.rmSync(localFixture, { recursive: true, force: true });
        }).not.toThrow();
      } finally {
        await localDaemon.stop();
        try {
          fs.rmSync(localFixture, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    });
  });
});
