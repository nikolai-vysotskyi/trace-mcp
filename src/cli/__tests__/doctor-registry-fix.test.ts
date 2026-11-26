import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TRA-50: `doctor --fix` already sweeps stale/overlapping registry entries
// non-interactively; `--fix-interactive` didn't touch the registry at all,
// leaving overlap cleanup to a manual `trace-mcp remove <path>` step. This
// pins the interactive counterpart: one confirm for the missing-root sweep,
// one per overlapping pair, and a decline leaves the entry registered.

const confirmMock = vi.fn();
vi.mock('@clack/prompts', () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
  isCancel: (v: unknown) => v === Symbol.for('clack:cancel'),
}));

describe('fixRegistryIssuesInteractive (TRA-50)', () => {
  let tmpHome: string;
  let registry: typeof import('../../registry.js');
  let doctor: typeof import('../doctor.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-doctor-fix-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    confirmMock.mockReset();
    registry = await import('../../registry.js');
    doctor = await import('../doctor.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeProjectDir(name: string): string {
    const dir = path.join(tmpHome, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('removes the overlap container when confirmed, keeps it when declined', async () => {
    const umbrella = makeProjectDir('ws');
    const child = makeProjectDir('ws/child');
    registry.registerProject(umbrella);
    registry.registerProject(child);

    const health = doctor.diagnoseRegistry();
    expect(health.overlaps).toHaveLength(1);

    confirmMock.mockResolvedValueOnce(false);
    const declined = await doctor.fixRegistryIssuesInteractive(health);
    expect(declined.removedOverlapContainers).toEqual([]);
    expect(registry.listProjects().map((e) => e.root)).toContain(umbrella);

    confirmMock.mockResolvedValueOnce(true);
    const accepted = await doctor.fixRegistryIssuesInteractive(health);
    expect(accepted.removedOverlapContainers).toEqual([umbrella]);
    expect(registry.listProjects().map((e) => e.root)).not.toContain(umbrella);
  });

  it('prunes missing-root entries only on confirmation', async () => {
    const gone = makeProjectDir('gamma');
    registry.registerProject(gone);
    fs.rmSync(gone, { recursive: true, force: true });

    const health = doctor.diagnoseRegistry();
    expect(health.staleCount).toBe(1);

    confirmMock.mockResolvedValueOnce(true);
    const result = await doctor.fixRegistryIssuesInteractive(health);
    expect(result.removedMissingRoots).toEqual([gone]);
    expect(registry.listProjects()).toEqual([]);
  });

  it('reports a truncated registered index without treating it as stale or fixable', () => {
    const root = makeProjectDir('large');
    const entry = registry.registerProject(root);
    fs.mkdirSync(path.dirname(entry.dbPath), { recursive: true });
    const db = new Database(entry.dbPath);
    db.exec('CREATE TABLE repo_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO repo_metadata (key, value) VALUES (?, ?)');
    insert.run('index_truncated', '1');
    insert.run('index_truncated_found', '35452');
    insert.run('index_truncated_limit', '10000');
    db.close();

    const health = doctor.diagnoseRegistry();
    expect(health.staleCount).toBe(0);
    expect(health.truncatedCount).toBe(1);
    expect(health.entries[0]).toMatchObject({
      status: 'ok',
      truncated: { found: 35452, limit: 10000 },
    });
  });

  // TRA-3214: a run that cleared `index_truncated` is supposed to delete its
  // `found`/`limit` companions in the same write (see stampTruncationMetadata
  // in pipeline.ts). This pins the registry-health side of the fix: should a
  // row ever end up with the flag cleared but a stale found>limit pair left
  // behind anyway (old data from before the fix, or a future write bug),
  // doctor must still report the overflow instead of trusting the flag.
  it('reports truncation from a stale found/limit pair even when the flag reads 0', () => {
    const root = makeProjectDir('stale-flag');
    const entry = registry.registerProject(root);
    fs.mkdirSync(path.dirname(entry.dbPath), { recursive: true });
    const db = new Database(entry.dbPath);
    db.exec('CREATE TABLE repo_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO repo_metadata (key, value) VALUES (?, ?)');
    insert.run('index_truncated', '0');
    insert.run('index_truncated_found', '57080');
    insert.run('index_truncated_limit', '40000');
    db.close();

    const health = doctor.diagnoseRegistry();
    expect(health.truncatedCount).toBe(1);
    expect(health.entries[0]).toMatchObject({
      truncated: { found: 57080, limit: 40000 },
    });
  });

  it('does not report truncation once the found/limit companions are cleared', () => {
    const root = makeProjectDir('cleared-flag');
    const entry = registry.registerProject(root);
    fs.mkdirSync(path.dirname(entry.dbPath), { recursive: true });
    const db = new Database(entry.dbPath);
    db.exec('CREATE TABLE repo_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO repo_metadata (key, value) VALUES (?, ?)').run('index_truncated', '0');
    db.close();

    const health = doctor.diagnoseRegistry();
    expect(health.truncatedCount).toBe(0);
    expect(health.entries[0].truncated).toBeUndefined();
  });
});
