import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('DecisionStore — heat / time-decay scoring', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/heat-test';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-heat-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  describe('schema migration', () => {
    it('adds hit_count and last_hit_at columns on fresh databases', () => {
      const cols = (store.db.pragma('table_info(decisions)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toContain('hit_count');
      expect(cols).toContain('last_hit_at');
    });

    it('migration is idempotent — re-opening an already-migrated DB does not error', () => {
      store.close();
      // Open + close + open again should not throw or duplicate columns.
      const reopened = new DecisionStore(dbPath);
      const cols = (reopened.db.pragma('table_info(decisions)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols.filter((c) => c === 'hit_count')).toHaveLength(1);
      expect(cols.filter((c) => c === 'last_hit_at')).toHaveLength(1);
      reopened.close();
      // Re-open store for the afterEach close().
      store = new DecisionStore(dbPath);
    });

    it('back-fills legacy decisions with hit_count=0 and null last_hit_at', () => {
      const d = store.addDecision({
        title: 'legacy',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      expect(d.hit_count).toBe(0);
      expect(d.last_hit_at).toBeNull();
    });
  });

  describe('recordHits', () => {
    it('increments hit_count and stamps last_hit_at for a single id', () => {
      const d = store.addDecision({
        title: 't',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      store.recordHits([d.id]);
      const after = store.getDecision(d.id)!;
      expect(after.hit_count).toBe(1);
      expect(after.last_hit_at).not.toBeNull();
      expect(Date.parse(after.last_hit_at!)).not.toBeNaN();
    });

    it('handles batches of ids in a single transaction', () => {
      const ids = Array.from(
        { length: 5 },
        (_, i) =>
          store.addDecision({
            title: `t${i}`,
            content: 'c',
            type: 'tech_choice',
            project_root: projectRoot,
          }).id,
      );
      store.recordHits(ids);
      for (const id of ids) {
        expect(store.getDecision(id)!.hit_count).toBe(1);
      }
    });

    it('silently ignores missing ids', () => {
      // 999 does not exist; the UPDATE no-ops via WHERE id=?.
      expect(() => store.recordHits([999, 1000])).not.toThrow();
    });

    it('handles empty arrays without errors', () => {
      expect(() => store.recordHits([])).not.toThrow();
    });

    it('accumulates across multiple calls', () => {
      const d = store.addDecision({
        title: 't',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      store.recordHits([d.id]);
      store.recordHits([d.id]);
      store.recordHits([d.id]);
      expect(store.getDecision(d.id)!.hit_count).toBe(3);
    });
  });

  describe('getHeat', () => {
    it('returns 0 for a missing decision', () => {
      expect(store.getHeat(9999)).toBe(0);
    });

    it('returns a positive number for an existing decision', () => {
      const d = store.addDecision({
        title: 't',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      const heat = store.getHeat(d.id);
      expect(heat).toBeGreaterThan(0);
    });

    it('rises after a recordHits call', () => {
      const d = store.addDecision({
        title: 't',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      const before = store.getHeat(d.id);
      store.recordHits([d.id]);
      const after = store.getHeat(d.id);
      expect(after).toBeGreaterThan(before);
    });

    it('honors halfLifeDays / freshnessDays overrides', () => {
      const d = store.addDecision({
        title: 't',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      store.recordHits([d.id]);
      const tight = store.getHeat(d.id, { halfLifeDays: 1, freshnessDays: 1 });
      const loose = store.getHeat(d.id, { halfLifeDays: 100, freshnessDays: 100 });
      // Both should be positive; the override path must not throw.
      expect(tight).toBeGreaterThan(0);
      expect(loose).toBeGreaterThan(0);
    });
  });

  describe('getHottest', () => {
    it('orders results by heat descending', () => {
      const a = store.addDecision({
        title: 'A',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      const b = store.addDecision({
        title: 'B',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      const c = store.addDecision({
        title: 'C',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      // Hit B the most, then A, then C none.
      store.recordHits([b.id, b.id, b.id, b.id, b.id]);
      store.recordHits([a.id, a.id]);
      const hottest = store.getHottest({ project_root: projectRoot, limit: 3 });
      expect(hottest[0].id).toBe(b.id);
      expect(hottest[1].id).toBe(a.id);
      expect(hottest[2].id).toBe(c.id);
    });

    it('filters by project_root', () => {
      store.addDecision({
        title: 'other',
        content: 'c',
        type: 'tech_choice',
        project_root: '/other/project',
      });
      const mine = store.addDecision({
        title: 'mine',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      const hottest = store.getHottest({ project_root: projectRoot, limit: 10 });
      expect(hottest.map((r) => r.id)).toEqual([mine.id]);
    });

    it('excludes invalidated rows', () => {
      const d = store.addDecision({
        title: 't',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      store.invalidateDecision(d.id);
      const hottest = store.getHottest({ project_root: projectRoot, limit: 10 });
      expect(hottest).toHaveLength(0);
    });

    it('excludes pending/rejected review_status rows by default', () => {
      const d = store.addDecision({
        title: 'pending',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
        review_status: 'pending',
      });
      const ok = store.addDecision({
        title: 'visible',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      const hottest = store.getHottest({ project_root: projectRoot, limit: 10 });
      const ids = hottest.map((r) => r.id);
      expect(ids).toContain(ok.id);
      expect(ids).not.toContain(d.id);
    });

    it('respects the limit cap', () => {
      for (let i = 0; i < 20; i++) {
        store.addDecision({
          title: `d${i}`,
          content: 'c',
          type: 'tech_choice',
          project_root: projectRoot,
        });
      }
      const hottest = store.getHottest({ project_root: projectRoot, limit: 5 });
      expect(hottest).toHaveLength(5);
    });
  });
});
