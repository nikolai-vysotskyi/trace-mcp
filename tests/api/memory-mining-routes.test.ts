/**
 * TRA-1689: the Memory tab is dead on a default install (background mining
 * defaults to off) and its empty states never said so. Pins the HTTP
 * contract of the two endpoints behind the fix:
 * GET /api/projects/memory/status and POST /api/projects/memory/mine.
 *
 * The suite-wide isolate-home setup file already redirects TRACE_MCP_HOME
 * to a per-worker temp dir, so the mining run below never touches the
 * developer's real decisions.db.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleMemoryRequest } from '../../src/api/memory-routes.js';

function startTestServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!handleMemoryRequest(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

describe('memory mining routes (TRA-1689)', () => {
  let srv: { baseUrl: string; close: () => Promise<void> } | null = null;
  let projectRoot: string;

  beforeEach(async () => {
    srv = await startTestServer();
    // A project with no sessions anywhere: mining it scans nothing and
    // resolves fast, independent of the machine's real session history.
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1689-proj-'));
  });

  afterEach(async () => {
    if (srv) await srv.close();
    srv = null;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('GET /api/projects/memory/status', () => {
    it('400s when ?project= is missing', async () => {
      const res = await fetch(`${srv!.baseUrl}/api/projects/memory/status`);
      expect(res.status).toBe(400);
    });

    it('reports the background flag (off by default, no config file)', async () => {
      const res = await fetch(
        `${srv!.baseUrl}/api/projects/memory/status?project=${encodeURIComponent(projectRoot)}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { backgroundEnabled: unknown };
      // No config file exists under the temp project or its parents that
      // enables mining — the default the issue complains about.
      expect(body.backgroundEnabled).toBe(false);
    });
  });

  describe('POST /api/projects/memory/mine', () => {
    it('400s when project_root is missing', async () => {
      const res = await fetch(`${srv!.baseUrl}/api/projects/memory/mine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('400s on invalid JSON', async () => {
      const res = await fetch(`${srv!.baseUrl}/api/projects/memory/mine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
    });

    it('mines a sessionless project to an empty result (one-shot, regex)', async () => {
      const res = await fetch(`${srv!.baseUrl}/api/projects/memory/mine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_root: projectRoot }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        scanned: number;
        mined: number;
        added: number;
        durationMs: number;
      };
      expect(body.scanned).toBe(0);
      expect(body.mined).toBe(0);
      expect(body.added).toBe(0);
      expect(typeof body.durationMs).toBe('number');
    });
  });

  it('does not match unrelated paths (returns false -> 404 from outer server)', async () => {
    const res = await fetch(`${srv!.baseUrl}/api/projects/memory/nonexistent`);
    expect(res.status).toBe(404);
  });
});
