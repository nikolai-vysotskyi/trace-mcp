/**
 * Decision-store rows must actually be dropped when a project is removed.
 *
 * `dropDecisionRows` used a bare `require('better-sqlite3')`, which the ESM
 * build rewrites to the module namespace object rather than the default
 * export — `new Database(...)` then threw "Database is not a constructor",
 * the non-fatal catch swallowed it, and every removal reported 0 rows dropped
 * while the decisions stayed on disk for a project the user had deleted.
 *
 * ponytail: the fixture builds the four project-scoped tables by hand with
 * only the column `dropDecisionRows` relies on. It guards the delete, not the
 * real DecisionStore schema.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TABLES = ['decisions', 'session_chunks', 'decision_clusters', 'project_memos'] as const;

let tmpHome: string;

async function seedDecisions(roots: string[]): Promise<void> {
  const { DECISIONS_DB_PATH, ensureGlobalDirs } = await import('../../global.js');
  ensureGlobalDirs();
  const db = new Database(DECISIONS_DB_PATH);
  try {
    for (const table of TABLES) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (project_root TEXT NOT NULL)`);
      for (const root of roots) {
        db.prepare(`INSERT INTO ${table} (project_root) VALUES (?)`).run(root);
      }
    }
  } finally {
    db.close();
  }
}

async function remainingRoots(table: string): Promise<string[]> {
  const { DECISIONS_DB_PATH } = await import('../../global.js');
  const db = new Database(DECISIONS_DB_PATH);
  try {
    return db
      .prepare(`SELECT project_root FROM ${table}`)
      .all()
      .map((r) => (r as { project_root: string }).project_root);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-artifacts-decisions-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('removeProjectArtifacts — decision rows', () => {
  it('drops the removed project rows and keeps every other project', async () => {
    const gone = path.join(tmpHome, 'gone');
    const kept = path.join(tmpHome, 'kept');
    await seedDecisions([gone, kept]);

    const { removeProjectArtifacts } = await import('../project-artifacts.js');
    const result = removeProjectArtifacts(gone);

    expect(result.decisions).toEqual({ decisions: 1, chunks: 1, clusters: 1, memos: 1 });
    for (const table of TABLES) expect(await remainingRoots(table)).toEqual([kept]);

    // Idempotent: a second removal finds nothing left to drop.
    expect(removeProjectArtifacts(gone).decisions).toEqual({
      decisions: 0,
      chunks: 0,
      clusters: 0,
      memos: 0,
    });
  });

  /**
   * The vitest transform hands modules a working `require`, so the two tests
   * above passed all along while every shipped bundle failed. This is the part
   * that would have caught it.
   *
   * tsup's `cjs-via-createRequire` plugin replaces each native external with an
   * ESM shim that default-exports the real module. `import Database from ...`
   * gets the constructor; `require(...)` gets the namespace object instead, and
   * `new` on it throws. Other `require()` calls are fine — the tsup banner
   * injects a real createRequire-backed `require`.
   *
   * ponytail: a file already using createRequire for one package is trusted for
   * all of them. Per-call resolution would need a parser.
   */
  it('no source file bare-requires a native external', () => {
    const config = fs.readFileSync('tsup.config.ts', 'utf8');
    const listed = config.slice(
      config.indexOf('const NATIVE_EXTERNALS'),
      config.indexOf('const buildRequire'),
    );
    const externals = [...listed.matchAll(/^\s*'([^']+)',$/gm)].map((m) => m[1]);
    expect(externals).toContain('better-sqlite3');
    const bareRequire = new RegExp(
      `(?<![.\\w])require\\(\\s*['"](${externals.join('|')})['"]\\s*\\)`,
    );

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = fs.readFileSync(full, 'utf8');
        if (source.includes('createRequire')) continue; // resolved explicitly, survives bundling
        if (bareRequire.test(source)) offenders.push(full);
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });

  it('is a no-op when no decisions DB exists', async () => {
    const { removeProjectArtifacts } = await import('../project-artifacts.js');
    expect(removeProjectArtifacts(path.join(tmpHome, 'nothing')).decisions).toEqual({
      decisions: 0,
      chunks: 0,
      clusters: 0,
      memos: 0,
    });
  });
});
