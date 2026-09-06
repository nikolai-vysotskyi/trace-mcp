/**
 * TRA-1053 regression guard: GET /api/dashboard/projects must never compute
 * inline. It used to run four full-table analyses per registered project on
 * the daemon's only thread — 20.5 s across a 38-project registry, well past
 * the renderer's 8 s ceiling, with every other route starved behind it.
 *
 * The ceiling below is deliberately generous (a cache read plus a registry
 * read); it fails only if request-time computation comes back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1053-'));
process.env.TRACE_MCP_DATA_DIR = tmpHome;

/** Minimal schema — enough for the three COUNT(*) queries the cheap pass runs. */
function makeDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, status TEXT);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE edges (id INTEGER PRIMARY KEY, src TEXT, dst TEXT);
  `);
  const f = db.prepare("INSERT INTO files (path, status) VALUES (?, 'ok')");
  for (let i = 0; i < 100; i++) f.run(`src/f${i}.ts`);
  db.close();
}

const PROJECT_COUNT = 40;

beforeAll(() => {
  const projects: Record<string, unknown> = {};
  for (let i = 0; i < PROJECT_COUNT; i++) {
    const root = path.join(tmpHome, `proj${i}`);
    const dbPath = path.join(tmpHome, `proj${i}.db`);
    // Half the registry points at databases that do not exist — the shape a
    // real registry drifts into (TRA-1054). Those rows must stay cheap too.
    if (i % 2 === 0) makeDb(dbPath);
    projects[root] = { name: `proj${i}`, root, dbPath, lastIndexed: null, addedAt: '' };
  }
  fs.writeFileSync(path.join(tmpHome, 'registry.json'), JSON.stringify({ version: 1, projects }));
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.TRACE_MCP_DATA_DIR = undefined;
});

/** Drive the handler without a socket: collect what it writes. */
async function get(url: string): Promise<{ status: number; body: string }> {
  const { handleDashboardRequest } = await import('../../src/api/dashboard-routes.js');
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string) {
      body = chunk ?? '';
    },
  };
  const handled = await handleDashboardRequest(
    { method: 'GET', url, headers: {} } as never,
    res as never,
  );
  expect(handled).toBe(true);
  return { status, body };
}

describe('GET /api/dashboard/projects', () => {
  it('answers a 40-project registry without computing inline', async () => {
    const t0 = performance.now();
    const first = await get('/api/dashboard/projects');
    const elapsed = performance.now() - t0;

    expect(first.status).toBe(200);
    const parsed = JSON.parse(first.body) as {
      projects: Array<{ root: string; status: string }>;
      computing: boolean;
    };
    expect(parsed.projects).toHaveLength(PROJECT_COUNT);
    // Every row is present from the first response — a project the background
    // pass has not reached yet says so rather than being missing.
    expect(parsed.computing).toBe(true);
    // 20.5 s before the fix. 500 ms leaves room for a cold CI filesystem and
    // still fails loudly if the analyses move back into the request.
    expect(elapsed).toBeLessThan(500);
  });

  it('stays fast on the second call', async () => {
    const t0 = performance.now();
    const res = await get('/api/dashboard/projects');
    expect(performance.now() - t0).toBeLessThan(200);
    expect(res.status).toBe(200);
  });
});
