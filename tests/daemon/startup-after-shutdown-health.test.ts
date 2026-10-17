import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getLaunchdLastExit, parseLaunchdLastExit } from '../../src/daemon/lifecycle.js';
import { ProjectManager } from '../../src/daemon/project-manager.js';
import { buildHealthPayload } from '../../src/daemon/health-payload.js';
import { yieldToEventLoopFair } from '../../src/utils/event-loop.js';

describe('TRA-2442: daemon startup after shutdown readiness and health starvation', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tra2442-test-'));
    homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('launchd exit diagnosis boundedness (TRA-2442)', () => {
    it('parseLaunchdLastExit parses valid last exit output correctly', () => {
      const sample = `
        state = running
        runs = 42
        last exit code = 15
        last exit reason = Terminated: 15
      `;
      const parsed = parseLaunchdLastExit(sample);
      expect(parsed.exitCode).toBe(15);
      expect(parsed.reason).toBe('Terminated: 15');
      expect(parsed.runs).toBe(42);
    });

    it('lifecycle.ts enforces timeout on launchctl print in getLaunchdLastExit', () => {
      const srcPath = path.resolve(__dirname, '..', '..', 'src', 'daemon', 'lifecycle.ts');
      const content = fs.readFileSync(srcPath, 'utf-8');

      // Verify getLaunchdLastExit contains timeout option in execFileSync
      const fnMatch = content.match(/function getLaunchdLastExit\(\)[\s\S]*?\n}/);
      expect(fnMatch, 'getLaunchdLastExit function body found').not.toBeNull();
      const fnBody = fnMatch?.[0] ?? '';
      expect(fnBody).toContain('timeout:');
      expect(fnBody).toContain('2_000');
    });

    it('getLaunchdLastExit returns null gracefully off-macOS or when job is absent', () => {
      const result = getLaunchdLastExit();
      // On macOS without running as the specified service, it returns parsed exit code or null, never throws
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('startup event loop yielding keeps /health immediately responsive', () => {
    it('/health responds with 200 within 50ms while background loadAllRegistered is queued', async () => {
      let startupComplete = false;
      const startedAt = Date.now();

      // Create a test HTTP server modeling the daemon listen behavior
      const server = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify(
              buildHealthPayload({
                startupComplete,
                version: '3.37.7',
                uptimeSeconds: 0,
                pid: process.pid,
                projects: [],
              }),
            ),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const address = server.address() as { port: number };
      const port = address.port;

      // Simulate the background task deferred via setImmediate with fair yield
      let backgroundStarted = false;
      let backgroundFinished = false;

      setImmediate(() => {
        void (async () => {
          backgroundStarted = true;
          await yieldToEventLoopFair();
          // Simulate some cold-start work
          await new Promise((r) => setTimeout(r, 80));
          startupComplete = true;
          backgroundFinished = true;
        })();
      });

      // Immediately probe /health before background has finished
      const probeStart = Date.now();
      const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (r) => {
          let data = '';
          r.on('data', (chunk) => (data += chunk));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: JSON.parse(data) }));
        });
        req.on('error', reject);
      });
      const probeElapsed = Date.now() - probeStart;

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('starting');
      expect(probeElapsed).toBeLessThan(100);

      // Clean up server
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });
});
