/**
 * TRA-1057 (part 2): a dbPath fingerprint only detects changes to the
 * *project's* index — not to trace-mcp's own grading code. A grade computed
 * and cached to disk by a pre-fix build (e.g. "A" for a project with no
 * symbols to score) would otherwise survive a binary upgrade forever, since
 * nothing ever marks that cache entry stale.
 *
 * This seeds `dashboard-cache.json` exactly as an old build would have left
 * it — a poisoned "A" grade, plus an `enrichedAt` fingerprint that matches
 * the on-disk DB so the ordinary staleness check would NOT recompute it —
 * and asserts the current build refuses to serve that cached grade.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1057-cache-'));
process.env.TRACE_MCP_DATA_DIR = tmpHome;

const root = path.join(tmpHome, 'empty-project');
const dbPath = path.join(tmpHome, 'empty-project.db');

beforeAll(async () => {
  fs.mkdirSync(root, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = MEMORY');
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, status TEXT);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE edges (id INTEGER PRIMARY KEY, src TEXT, dst TEXT);
  `);
  db.close();

  fs.writeFileSync(
    path.join(tmpHome, 'registry.json'),
    JSON.stringify({
      version: 1,
      projects: {
        [root]: { name: 'empty-project', root, dbPath, lastIndexed: null, addedAt: '' },
      },
    }),
  );

  const { indexFingerprint } = await import('../../src/api/dashboard-routes.js');
  const fingerprint = indexFingerprint(dbPath);

  // No `version` field — the shape a pre-TRA-1057 build wrote.
  fs.writeFileSync(
    path.join(tmpHome, 'dashboard-cache.json'),
    JSON.stringify({
      computedAt: Date.now(),
      projects: [
        {
          root,
          name: 'empty-project',
          status: 'ok',
          lastIndexed: null,
          totalFiles: 0,
          totalSymbols: 0,
          totalEdges: 0,
          deadExports: 0,
          untestedSymbols: 0,
          techDebtGrade: 'A', // the poison: TRA-1057's exact symptom
          securityFindings: 0,
        },
      ],
      enrichedAt: [[root, fingerprint]], // matches → ordinary staleness check would trust it
    }),
  );
});

afterAll(async () => {
  const { waitForIdleForTests } = await import('../../src/api/dashboard-routes.js');
  await waitForIdleForTests();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup, see dashboard-routes.test.ts */
  }
  delete process.env.TRACE_MCP_DATA_DIR;
});

async function get(): Promise<{ techDebtGrade?: string; status: string } | undefined> {
  const { handleDashboardRequest } = await import('../../src/api/dashboard-routes.js');
  let body = '';
  const res = {
    writeHead() {},
    end(chunk?: string) {
      body = chunk ?? '';
    },
  };
  await handleDashboardRequest(
    { method: 'GET', url: '/api/dashboard/projects', headers: {} } as never,
    res as never,
  );
  const parsed = JSON.parse(body) as {
    projects: Array<{ root: string; status: string; techDebtGrade?: string }>;
  };
  return parsed.projects.find((p) => p.root === root);
}

describe('dashboard cache version invalidation (TRA-1057)', () => {
  it('never serves a pre-fix cached grade for a project with nothing to grade', async () => {
    let project = await get();
    // Poll rather than assert on the first response: the route never computes
    // inline (TRA-1053), so a fresh pass runs in the background.
    for (let i = 0; i < 50 && project?.status === 'computing'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      project = await get();
    }
    expect(project?.techDebtGrade).not.toBe('A');
  });
});
