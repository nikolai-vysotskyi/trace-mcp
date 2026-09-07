/**
 * TRA-1057 review finding (Reviewer B, CONFIRMED): `enrich()` seeded `out`
 * from `basics`, which can carry a `techDebtGrade` forward from a previous
 * pass (TRA-1072's "don't blank the screen mid-recompute" carry-forward).
 * The old code only *overwrote* `out.techDebtGrade` when `getTechDebt()`
 * returned a truthy grade — so a project that shrinks below
 * `MIN_SYMBOLS_FOR_GRADE` (or whose analysis throws) kept its last real
 * grade forever, which is exactly the "Healthy" tile lie this issue is
 * about, just reached through an update instead of day one.
 *
 * This seeds a project with enough symbols to earn a real grade, lets the
 * background pass cache it, then shrinks the project below the floor and
 * asserts the grade is dropped rather than carried forward.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1057-stale-grade-'));
process.env.TRACE_MCP_DATA_DIR = tmpHome;

const root = path.join(tmpHome, 'shrinking-project');
const dbPath = path.join(tmpHome, 'shrinking-project.db');

function insertGradeableSymbols(store: Store, count: number): void {
  const fileId = store.insertFile('src/big.ts', 'typescript', `h-${count}`, 100);
  for (let i = 0; i < count; i++) {
    store.insertSymbol(fileId, {
      symbolId: `sym:big::fn${i}`,
      name: `fn${i}`,
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
      metadata: { cyclomatic: 12 }, // non-trivial, so a grade actually computes
    });
  }
}

beforeAll(() => {
  fs.mkdirSync(root, { recursive: true });

  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  insertGradeableSymbols(store, 25); // above MIN_SYMBOLS_FOR_GRADE
  db.close();

  fs.writeFileSync(
    path.join(tmpHome, 'registry.json'),
    JSON.stringify({
      version: 1,
      projects: {
        [root]: { name: 'shrinking-project', root, dbPath, lastIndexed: null, addedAt: '' },
      },
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

async function refreshAndSettle(): Promise<{ techDebtGrade?: string; status: string } | undefined> {
  const { handleDashboardRequest, waitForIdleForTests } = await import(
    '../../src/api/dashboard-routes.js'
  );
  let body = '';
  await handleDashboardRequest(
    { method: 'POST', url: '/api/dashboard/refresh', headers: {} } as never,
    { writeHead() {}, end: (c?: string) => (body = c ?? '') } as never,
  );
  void body;
  await waitForIdleForTests();
  return get();
}

describe('dashboard drops a stale grade when a project shrinks (TRA-1057)', () => {
  it('never carries a prior real grade forward once the project is too small to grade', async () => {
    // Pass 1 must actually reach `ok`/graded before we shrink anything.
    let project = await get();
    for (let i = 0; i < 50 && project?.status === 'computing'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      project = await get();
    }
    expect(project?.status).toBe('ok');
    expect(['A', 'B', 'C', 'D', 'F']).toContain(project?.techDebtGrade);

    // Shrink the project to 1 symbol — below MIN_SYMBOLS_FOR_GRADE — and
    // force the fingerprint to move so refreshAll() treats it as stale.
    const db = new Database(dbPath);
    db.exec('DELETE FROM symbols WHERE id NOT IN (SELECT id FROM symbols LIMIT 1)');
    db.close();

    project = await refreshAndSettle();
    expect(project?.status).toBe('ok');
    expect(project?.techDebtGrade).toBeUndefined();
  });
});
