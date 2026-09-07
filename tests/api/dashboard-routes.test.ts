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
    // Every root exists on disk — this fixture is about the DB half of
    // "not yet indexed", not the "the folder itself is gone" case (that one
    // gets its own registry entry below, TRA-1054).
    fs.mkdirSync(root, { recursive: true });
    // Half the registry points at databases that do not exist — the shape a
    // real registry drifts into. Those rows must stay cheap too.
    if (i % 2 === 0) makeDb(dbPath);
    projects[root] = { name: `proj${i}`, root, dbPath, lastIndexed: null, addedAt: '' };
  }
  // A registry row whose root directory has been deleted — the ghost entry
  // TRA-1054 is about. Must classify as `missing`, not `not_loaded`.
  const goneRoot = path.join(tmpHome, 'gone-project');
  projects[goneRoot] = {
    name: 'gone-project',
    root: goneRoot,
    dbPath: path.join(tmpHome, 'gone-project.db'),
    lastIndexed: null,
    addedAt: '',
  };
  fs.writeFileSync(path.join(tmpHome, 'registry.json'), JSON.stringify({ version: 1, projects }));
  // No timeout override on purpose: the seed is ~10ms now, so the default hook
  // ceiling is the regression guard. If this hook ever needs a bigger number
  // again, the seed got expensive — fix the seed, not the ceiling (TRA-790).
});

afterAll(async () => {
  // The background refreshAll() this suite triggers is fire-and-forget
  // (`void refreshAll()` in dashboard-routes.ts) and opens each project's DB
  // again for the expensive pass — nothing in this file awaits it, so a
  // handle can still be open on `projN.db` the instant the last test
  // resolves. `waitForIdleForTests()` resolves once that pass has actually
  // finished, which clears the ordinary case.
  //
  // What's left is a Windows-only residue this repo has hit before for a
  // different file (TRA-1104): the OS can keep a just-closed file briefly
  // busy after a legitimate close() — outside the process's control and not
  // bounded by anything this suite does. POSIX tolerates unlinking an open
  // file regardless; Windows doesn't (EBUSY). The temp directory lives under
  // `os.tmpdir()` on a CI runner that is destroyed after the job — failing
  // to delete a few KB of leftover fixture there is not a real problem, so
  // cleanup best-effort and never fails the suite over it.
  const { waitForIdleForTests } = await import('../../src/api/dashboard-routes.js');
  await waitForIdleForTests();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort — see above */
  }
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
    expect(parsed.projects).toHaveLength(PROJECT_COUNT + 1); // +1 for the deleted-root fixture below
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

  // TRA-1054: a registry row whose `root` no longer exists on disk is a dead
  // row, not "not yet indexed" — the two must not collapse to the same
  // status, because the UI decides Open/Re-index and the KPI denominator off
  // it (types.ts deriveKpis / statusLabel). The route never computes inline
  // (TRA-1053), so a brand-new row reads `computing` until the background
  // pass reaches it — poll rather than asserting on the very first response.
  it('classifies a deleted-root registry entry as `missing`, not `not_loaded`', async () => {
    let status: string | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await get('/api/dashboard/projects');
      const parsed = JSON.parse(res.body) as { projects: Array<{ root: string; status: string }> };
      status = parsed.projects.find((p) => p.root.endsWith('gone-project'))?.status;
      if (status && status !== 'computing') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe('missing');
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
