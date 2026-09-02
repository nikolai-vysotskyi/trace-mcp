/**
 * TRA-559: a cleanup tier that throws must be reported as failed, not read
 * back as "found nothing to do". Before this, every one of these catch sites
 * logged a warning and returned a zero/empty value indistinguishable from a
 * project that genuinely had nothing left to clean up — which is exactly how
 * TRA-542's `dropDecisionRows` crash (a bare `require('better-sqlite3')`
 * throwing "Database is not a constructor" on every shipped build) went
 * unnoticed: the removal path answered `decisions: {0,0,0,0}` and both the
 * API response and the desktop app read it as a clean removal.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function makeGitRepo(root: string): void {
  mkdirp(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
}

describe('removeProjectArtifacts — failure reporting (TRA-559)', () => {
  let tmpHome: string;
  let tmpProjects: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-artifacts-failures-home-'));
    tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-artifacts-failures-projects-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProjects, { recursive: true, force: true });
  });

  it('reports an unlink failure as a failure, not a silent skip', async () => {
    const root = path.join(tmpProjects, 'run-1');
    makeGitRepo(root);

    const registry = await import('../../registry.js');
    const entry = registry.registerProject(root);
    mkdirp(path.dirname(entry.dbPath));
    fs.writeFileSync(entry.dbPath, '');

    const realUnlinkSync = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (target === entry.dbPath) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target);
    });

    const { removeProjectArtifacts } = await import('../project-artifacts.js');
    const result = removeProjectArtifacts(root);

    // The old behaviour: file just doesn't show up in `deleted`, indistinguishable
    // from "there was nothing to delete".
    expect(result.deleted).not.toContain(entry.dbPath);
    // The fix: the failure is visible instead of silently folded into a zero.
    expect(result.failures).toContainEqual(
      expect.objectContaining({ tier: 'index_db', error: expect.stringContaining('EACCES') }),
    );
    expect(fs.existsSync(entry.dbPath)).toBe(true);
  });

  it('reports a decision-table delete failure instead of reading it as zero rows dropped', async () => {
    const root = path.join(tmpProjects, 'run-1');

    const { DECISIONS_DB_PATH, ensureGlobalDirs } = await import('../../global.js');
    ensureGlobalDirs();
    const db = new Database(DECISIONS_DB_PATH);
    try {
      // Missing `project_root` column: the DELETE below throws "no such column",
      // a real failure distinct from the "no such table" case the code already
      // treats as a legitimate no-op on older DBs.
      db.exec('CREATE TABLE decisions (id INTEGER PRIMARY KEY)');
      db.exec('CREATE TABLE session_chunks (project_root TEXT NOT NULL)');
      db.exec('CREATE TABLE decision_clusters (project_root TEXT NOT NULL)');
      db.exec('CREATE TABLE project_memos (project_root TEXT NOT NULL)');
    } finally {
      db.close();
    }

    const { removeProjectArtifacts } = await import('../project-artifacts.js');
    const result = removeProjectArtifacts(root);

    // The old behaviour: this table's count stays 0, same as "nothing to drop".
    expect(result.decisions.decisions).toBe(0);
    // The fix: the failure is visible instead of a silent zero.
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        tier: 'decisions.decisions',
        error: expect.stringContaining('no such column'),
      }),
    );
  });
});
