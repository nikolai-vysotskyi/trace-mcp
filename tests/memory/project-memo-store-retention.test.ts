/**
 * Tests for `DecisionStore.saveProjectMemo` retention semantics. The store
 * caps each (project_root, service_name) scope at `memoHistoryLimit` rows,
 * pruning older versions in the same transaction as the INSERT. Other
 * scopes must be untouched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('DecisionStore.saveProjectMemo — retention', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/memo-retention-test';

  function makeStore(memoHistoryLimit?: number): DecisionStore {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memo-retention-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    return new DecisionStore(dbPath, { memoHistoryLimit });
  }

  beforeEach(() => {
    store = makeStore(10);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('keeps at most `historyLimit` rows per scope after many saves', () => {
    for (let i = 0; i < 15; i++) {
      store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: `memo-v${i + 1}`,
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
    }
    const rows = (
      store.db
        .prepare(
          `SELECT version FROM project_memos
             WHERE project_root = ?
             ORDER BY version ASC`,
        )
        .all(projectRoot) as Array<{ version: number }>
    ).map((r) => r.version);
    expect(rows).toHaveLength(10);
    // The retained slice is the most-recent 10 — versions 6..15.
    expect(rows[0]).toBe(6);
    expect(rows[rows.length - 1]).toBe(15);

    const latest = store.getLatestProjectMemo({ project_root: projectRoot });
    expect(latest?.version).toBe(15);
    expect(latest?.memo_md).toBe('memo-v15');
  });

  it('retains each scope independently — scope A 15 stays at 10, scope B 5 stays at 5', () => {
    const projectA = '/projects/A';
    const projectB = '/projects/B';
    for (let i = 0; i < 15; i++) {
      store.saveProjectMemo({
        project_root: projectA,
        memo_md: `a-${i + 1}`,
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
    }
    for (let i = 0; i < 5; i++) {
      store.saveProjectMemo({
        project_root: projectB,
        memo_md: `b-${i + 1}`,
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
    }
    const countA = (
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM project_memos WHERE project_root = ?`)
        .get(projectA) as { n: number }
    ).n;
    const countB = (
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM project_memos WHERE project_root = ?`)
        .get(projectB) as { n: number }
    ).n;
    expect(countA).toBe(10);
    expect(countB).toBe(5);
  });

  it('treats (project_root, service_name) as the scope key — service-scoped memos retain independently', () => {
    for (let i = 0; i < 12; i++) {
      store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: `p-${i + 1}`,
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
    }
    for (let i = 0; i < 12; i++) {
      store.saveProjectMemo({
        project_root: projectRoot,
        service_name: 'auth-api',
        memo_md: `s-${i + 1}`,
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
    }
    const projectScopeCount = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM project_memos
             WHERE project_root = ? AND service_name IS NULL`,
        )
        .get(projectRoot) as { n: number }
    ).n;
    const serviceScopeCount = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM project_memos
             WHERE project_root = ? AND service_name = ?`,
        )
        .get(projectRoot, 'auth-api') as { n: number }
    ).n;
    expect(projectScopeCount).toBe(10);
    expect(serviceScopeCount).toBe(10);
  });

  it('defaults `historyLimit` to 10 when the constructor option is omitted', () => {
    store.close();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memo-default-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
    for (let i = 0; i < 12; i++) {
      store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: `m-${i + 1}`,
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
    }
    const count = (
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM project_memos WHERE project_root = ?`)
        .get(projectRoot) as { n: number }
    ).n;
    expect(count).toBe(10);
  });

  it('honours a custom `historyLimit` (e.g. 3) and prunes to that bound', () => {
    store.close();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memo-custom-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath, { memoHistoryLimit: 3 });
    for (let i = 0; i < 7; i++) {
      store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: `x-${i + 1}`,
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
    }
    const versions = (
      store.db
        .prepare(
          `SELECT version FROM project_memos
             WHERE project_root = ?
             ORDER BY version ASC`,
        )
        .all(projectRoot) as Array<{ version: number }>
    ).map((r) => r.version);
    expect(versions).toEqual([5, 6, 7]);
  });
});
