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
  // One transaction, no rollback journal. The seed used to run its 100 inserts
  // in autocommit: 20 databases x 100 commits = 2000 journal files created,
  // fsynced and deleted. That is ~1s on macOS and minutes on a Windows runner
  // whose antivirus scans every one of those creations (TRA-1104) — which is
  // why raising the hook ceiling from 15s to 60s only moved the boundary.
  db.pragma('journal_mode = MEMORY');
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, status TEXT);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE edges (id INTEGER PRIMARY KEY, src TEXT, dst TEXT);
  `);
  const f = db.prepare("INSERT INTO files (path, status) VALUES (?, 'ok')");
  db.transaction(() => {
    for (let i = 0; i < 100; i++) f.run(`src/f${i}.ts`);
  })();
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
  // No timeout override on purpose: the seed is ~10ms now, so the default hook
  // ceiling is the regression guard. If this hook ever needs a bigger number
  // again, the seed got expensive — fix the seed, not the ceiling (TRA-790).
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.TRACE_MCP_DATA_DIR;
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
      computedAt: number;
    };
    expect(parsed.projects).toHaveLength(PROJECT_COUNT);
    // The cache outlives a daemon restart, so the age of the numbers has to
    // travel with them — a snapshot that cannot date itself is TRA-1072.
    expect(typeof parsed.computedAt).toBe('number');
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

describe('indexFingerprint', () => {
  /**
   * The staleness key for the expensive pass. `RegistryEntry.lastIndexed` was
   * the obvious choice and is wrong: it is written once, at registration, and
   * the file watcher's incremental reindex never touches it — so keying off it
   * froze every actively-edited project's metrics for the daemon's lifetime.
   * This asserts the replacement actually moves when the index is written.
   */
  it('moves when the index is written, including through the WAL sidecar', async () => {
    const { indexFingerprint } = await import('../../src/api/dashboard-routes.js');
    const dbPath = path.join(tmpHome, 'fingerprint.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const before = indexFingerprint(dbPath);
    expect(before).toBeGreaterThan(0);

    // A later mtime needs a later clock tick on filesystems with coarse
    // timestamps; write until it moves rather than sleeping a fixed amount.
    let after = before;
    for (let i = 0; i < 50 && after === before; i++) {
      db.prepare('INSERT INTO t (v) VALUES (?)').run(`row${i}`);
      after = indexFingerprint(dbPath);
    }
    db.close();
    expect(after).toBeGreaterThan(before);
  });

  it('returns 0 for a database that is not there', async () => {
    const { indexFingerprint } = await import('../../src/api/dashboard-routes.js');
    expect(indexFingerprint(path.join(tmpHome, 'nope.db'))).toBe(0);
  });
});
