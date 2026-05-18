import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('DecisionStore — project memos (L3 orientation digest)', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/memo-store-test';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memo-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  describe('schema migration', () => {
    it('creates the project_memos table on a fresh DB', () => {
      const tables = (
        store.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_memos'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toContain('project_memos');
    });

    it('creates the scope index', () => {
      const idx = (
        store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_project_memos_scope'",
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(idx).toContain('idx_project_memos_scope');
    });

    it('migration is idempotent — re-opening an already-migrated DB does not error', () => {
      store.close();
      const reopened = new DecisionStore(dbPath);
      const tables = (
        reopened.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_memos'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toContain('project_memos');
      reopened.close();
      store = new DecisionStore(dbPath); // afterEach close()
    });
  });

  describe('saveProjectMemo + getLatestProjectMemo', () => {
    it('persists a memo and reads it back', () => {
      const saved = store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: '## Architecture\n\nWe use a layered approach.',
        model: 'mock-model',
        last_decision_id: 0,
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 12,
      });
      expect(saved.id).toBeGreaterThan(0);
      expect(saved.version).toBe(1);

      const fetched = store.getLatestProjectMemo({ project_root: projectRoot });
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(saved.id);
      expect(fetched!.memo_md).toContain('Architecture');
      expect(fetched!.model).toBe('mock-model');
      expect(fetched!.version).toBe(1);
      expect(fetched!.service_name).toBeNull();
    });

    it('getLatestProjectMemo returns undefined when no memo exists', () => {
      expect(store.getLatestProjectMemo({ project_root: projectRoot })).toBeUndefined();
    });

    it('subsequent saves increment version + return the latest', () => {
      store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: 'first',
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
      const second = store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: 'second',
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
      expect(second.version).toBe(2);

      const latest = store.getLatestProjectMemo({ project_root: projectRoot });
      expect(latest!.memo_md).toBe('second');
      expect(latest!.version).toBe(2);
    });

    it('service-scoped memos are independent from project-wide memos', () => {
      store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: 'project-wide',
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
      store.saveProjectMemo({
        project_root: projectRoot,
        service_name: 'auth-api',
        memo_md: 'auth service',
        decisions_at_generation: 0,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
      const project = store.getLatestProjectMemo({ project_root: projectRoot });
      const service = store.getLatestProjectMemo({
        project_root: projectRoot,
        service_name: 'auth-api',
      });
      expect(project!.memo_md).toBe('project-wide');
      expect(service!.memo_md).toBe('auth service');
      expect(project!.version).toBe(1);
      expect(service!.version).toBe(1);
    });
  });

  describe('listProjectMemos', () => {
    it('returns history newest-first', () => {
      for (let i = 0; i < 3; i++) {
        store.saveProjectMemo({
          project_root: projectRoot,
          memo_md: `memo-v${i + 1}`,
          decisions_at_generation: 0,
          clusters_at_generation: 0,
          estimated_tokens: 1,
        });
      }
      const history = store.listProjectMemos({ project_root: projectRoot, limit: 5 });
      expect(history).toHaveLength(3);
      expect(history[0].version).toBe(3);
      expect(history[2].version).toBe(1);
    });

    it('respects the limit', () => {
      for (let i = 0; i < 5; i++) {
        store.saveProjectMemo({
          project_root: projectRoot,
          memo_md: 'x',
          decisions_at_generation: 0,
          clusters_at_generation: 0,
          estimated_tokens: 1,
        });
      }
      expect(store.listProjectMemos({ project_root: projectRoot, limit: 2 })).toHaveLength(2);
    });
  });

  describe('countDecisionsSinceLastMemo', () => {
    it('returns the active decision count when no prior memo exists', () => {
      store.addDecision({
        title: 'd1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      store.addDecision({
        title: 'd2',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      expect(store.countDecisionsSinceLastMemo({ project_root: projectRoot })).toBe(2);
    });

    it('counts only decisions added AFTER the last memo', () => {
      const d1 = store.addDecision({
        title: 'd1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: 'memo',
        last_decision_id: d1.id,
        decisions_at_generation: 1,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
      // No new decisions yet.
      expect(store.countDecisionsSinceLastMemo({ project_root: projectRoot })).toBe(0);
      store.addDecision({
        title: 'd2',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      store.addDecision({
        title: 'd3',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      expect(store.countDecisionsSinceLastMemo({ project_root: projectRoot })).toBe(2);
    });

    it('excludes invalidated decisions from the count', () => {
      const d1 = store.addDecision({
        title: 'd1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      store.saveProjectMemo({
        project_root: projectRoot,
        memo_md: 'memo',
        last_decision_id: d1.id,
        decisions_at_generation: 1,
        clusters_at_generation: 0,
        estimated_tokens: 1,
      });
      const d2 = store.addDecision({
        title: 'd2',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      store.invalidateDecision(d2.id);
      expect(store.countDecisionsSinceLastMemo({ project_root: projectRoot })).toBe(0);
    });

    it('service-scoped count is independent from project-wide count', () => {
      // Project-wide memo, no service decisions yet.
      store.addDecision({
        title: 'p1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      store.addDecision({
        title: 's1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
        service_name: 'auth-api',
      });
      expect(
        store.countDecisionsSinceLastMemo({
          project_root: projectRoot,
          service_name: 'auth-api',
        }),
      ).toBe(1);
      expect(store.countDecisionsSinceLastMemo({ project_root: projectRoot })).toBe(2);
    });
  });
});
