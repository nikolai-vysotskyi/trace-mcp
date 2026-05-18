import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('queryDecisions — order_by heat', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/q-heat';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-heat-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('default ordering remains recency-by-valid_from (insertion order, newest first)', () => {
    // Insert with explicit, distinct valid_from timestamps so the DESC sort
    // produces a deterministic order regardless of how fast we insert.
    const a = store.addDecision({
      title: 'A',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      valid_from: '2026-01-01T00:00:00.000Z',
    });
    const b = store.addDecision({
      title: 'B',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      valid_from: '2026-02-01T00:00:00.000Z',
    });
    const c = store.addDecision({
      title: 'C',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      valid_from: '2026-03-01T00:00:00.000Z',
    });
    // Bias hits to A so heat ordering would change things if it were default.
    store.recordHits([a.id, a.id, a.id, a.id, a.id]);

    const res = store.queryDecisions({ project_root: projectRoot });
    expect(res.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
  });

  it("order_by='heat' surfaces frequently-hit rows above untouched ones", () => {
    const a = store.addDecision({
      title: 'A',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      valid_from: '2026-01-01T00:00:00.000Z',
    });
    const b = store.addDecision({
      title: 'B',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      valid_from: '2026-02-01T00:00:00.000Z',
    });
    const c = store.addDecision({
      title: 'C',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      valid_from: '2026-03-01T00:00:00.000Z',
    });
    // B is the celebrity; C is brand new (gets freshness floor); A is cold.
    store.recordHits([b.id, b.id, b.id, b.id, b.id, b.id, b.id, b.id, b.id, b.id]);

    const res = store.queryDecisions({
      project_root: projectRoot,
      order_by: 'heat',
    });
    // B was hit 10 times; A and C are untouched. B must rank first; A (oldest
    // valid_from, no hits) must rank last after C wins the tie-break.
    expect(res[0].id).toBe(b.id);
    expect(res.map((r) => r.id)).toContain(a.id);
    expect(res.map((r) => r.id)).toContain(c.id);
    // C is newer than A → ties on freshness, breaks by valid_from DESC → C, A.
    const aIdx = res.findIndex((r) => r.id === a.id);
    const cIdx = res.findIndex((r) => r.id === c.id);
    expect(cIdx).toBeLessThan(aIdx);
  });

  it("order_by='created_at' returns rows in insertion order, newest first", () => {
    // created_at is stamped at insert time. Inserts in the same millisecond
    // share the same value; we space them out so the DESC sort is stable.
    const a = store.addDecision({
      title: 'A',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    // Force at least one ms of separation so created_at differs.
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    return sleep(5).then(() => {
      const b = store.addDecision({
        title: 'B',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
      const res = store.queryDecisions({
        project_root: projectRoot,
        order_by: 'created_at',
      });
      expect(res[0].id).toBe(b.id);
      expect(res[1].id).toBe(a.id);
    });
  });

  it("order_by='heat' respects the limit cap", () => {
    for (let i = 0; i < 20; i++) {
      store.addDecision({
        title: `t${i}`,
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      });
    }
    const res = store.queryDecisions({
      project_root: projectRoot,
      order_by: 'heat',
      limit: 5,
    });
    expect(res).toHaveLength(5);
  });

  it("order_by='heat' still honors review_status defaults (hides pending)", () => {
    const visible = store.addDecision({
      title: 'visible',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    const pending = store.addDecision({
      title: 'pending',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      review_status: 'pending',
    });
    // Bias hits to pending — it should still be hidden.
    store.recordHits([pending.id, pending.id, pending.id]);
    const res = store.queryDecisions({
      project_root: projectRoot,
      order_by: 'heat',
    });
    expect(res.map((r) => r.id)).toEqual([visible.id]);
  });

  it("order_by='heat' still excludes invalidated decisions by default", () => {
    const live = store.addDecision({
      title: 'live',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    const dead = store.addDecision({
      title: 'dead',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    store.recordHits([dead.id, dead.id]);
    store.invalidateDecision(dead.id);
    const res = store.queryDecisions({
      project_root: projectRoot,
      order_by: 'heat',
    });
    expect(res.map((r) => r.id)).toEqual([live.id]);
  });
});
