/**
 * TRA-2946: Test daemon isolation and PID guard tests.
 *
 * Verifies that:
 * 1. Client-side isolation guards reject port 3741 and any PID matching the live daemon.
 * 2. Server-side dangerous root check rejects temporary test fixtures on a live daemon.
 * 3. An isolated test daemon with dedicated port & data dir registers, queries, and cleanly
 *    tears down a test project without touching the live daemon or registry.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDangerousProjectRoot, isTestFixturePath } from '../../src/dangerous-root.js';
import {
  assertNotLiveDaemon,
  getFreePort,
  getLiveDaemonPid,
  registerTestProject,
  spawnTestDaemon,
  type TestDaemonInstance,
} from '../helpers/test-daemon.js';

describe('TRA-2946: Test daemon isolation and live daemon protection', () => {
  describe('Client isolation guards (assertNotLiveDaemon & registerTestProject)', () => {
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

    it('permits non-3741 port with non-colliding PID', async () => {
      await expect(
        assertNotLiveDaemon({
          port: 3888,
          pid: 12345,
          livePid: 54321,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('Server-side fixture detection and dangerous root guard (isDangerousProjectRoot)', () => {
    it('detects test fixture naming patterns correctly via isTestFixturePath', () => {
      expect(isTestFixturePath('/tmp/trace-mcp-tra2941-isolated')).toBe(true);
      expect(isTestFixturePath('/private/tmp/trace-mcp-tra2941-isolated')).toBe(true);
      expect(isTestFixturePath('/tmp/trace-mcp-test-home-12345')).toBe(true);
      expect(isTestFixturePath('/tmp/trace-restart-indexing-abc')).toBe(true);
      expect(isTestFixturePath('/tmp/tmcp-packaged-lab-xyz')).toBe(true);
      expect(isTestFixturePath('/tmp/truncation-boundary-2941-test')).toBe(true);
      expect(isTestFixturePath('/var/folders/xx/yy/T/trace-mcp-tra2941-isolated')).toBe(true);

      // Real user repositories must NOT be classified as test fixtures
      expect(isTestFixturePath('/Users/nikolai/PhpstormProjects/general')).toBe(false);
      expect(isTestFixturePath('/Users/nikolai/trace-mcp')).toBe(false);
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

  describe('Isolated test daemon lifecycle and verifiable teardown', () => {
    let daemon: TestDaemonInstance | null = null;
    let fixtureDir: string;

    beforeAll(async () => {
      // Allocate free port and spawn dedicated test daemon
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
  });
});
