/**
 * E10 — ranking pins. Verify pin storage, weight bounds, expiry, the active
 * cap, and the effect on PageRank ordering.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import {
  PIN_MAX_ACTIVE,
  PIN_WEIGHT_DEFAULT,
  countActivePins,
  deletePin,
  invalidatePinsCache,
  listPins,
  upsertPin,
} from '../../src/scoring/pins.js';
import { invalidatePageRankCache } from '../../src/scoring/pagerank.js';
import { getPageRank } from '../../src/tools/analysis/graph-analysis.js';
import { createTestStore } from '../test-utils.js';

function insertFile(store: Store, path: string, lang = 'typescript'): number {
  return store.insertFile(path, lang, `hash_${path}`, 100);
}

function insertEdge(store: Store, srcNodeId: number, tgtNodeId: number, edgeType: string): void {
  store.insertEdge(srcNodeId, tgtNodeId, edgeType);
}

describe('ranking pins — CRUD', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    invalidatePinsCache();
  });

  it('upserts and reads back a file pin with the supplied weight', () => {
    const res = upsertPin(store.db, { scope: 'file', target_id: 'src/foo.ts', weight: 2.5 });
    expect(res.ok).toBe(true);
    expect(res.row?.weight).toBe(2.5);
    expect(res.row?.scope).toBe('file');
    expect(res.row?.target_id).toBe('src/foo.ts');

    const pins = listPins(store.db);
    expect(pins).toHaveLength(1);
    expect(pins[0].target_id).toBe('src/foo.ts');
  });

  it('rejects weights outside the [0.1, 3.0] bound', () => {
    const tooHigh = upsertPin(store.db, { scope: 'file', target_id: 'src/foo.ts', weight: 10 });
    expect(tooHigh.ok).toBe(false);
    const tooLow = upsertPin(store.db, { scope: 'file', target_id: 'src/foo.ts', weight: 0 });
    expect(tooLow.ok).toBe(false);
  });

  it('uses default weight when not provided', () => {
    const res = upsertPin(store.db, { scope: 'symbol', target_id: 'sym:Foo' });
    expect(res.ok).toBe(true);
    expect(res.row?.weight).toBe(PIN_WEIGHT_DEFAULT);
  });

  it('updates an existing row in place (does not consume cap slot)', () => {
    upsertPin(store.db, { scope: 'file', target_id: 'src/foo.ts', weight: 2.0 });
    expect(countActivePins(store.db)).toBe(1);
    const updated = upsertPin(store.db, { scope: 'file', target_id: 'src/foo.ts', weight: 1.5 });
    expect(updated.ok).toBe(true);
    expect(updated.row?.weight).toBe(1.5);
    expect(countActivePins(store.db)).toBe(1);
  });

  it('enforces the active-pin cap', () => {
    for (let i = 0; i < PIN_MAX_ACTIVE; i++) {
      const r = upsertPin(store.db, { scope: 'file', target_id: `src/f${i}.ts` });
      expect(r.ok).toBe(true);
    }
    const overflow = upsertPin(store.db, { scope: 'file', target_id: 'src/extra.ts' });
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toMatch(/cap reached/);
  });

  it('deletes by (scope, target_id)', () => {
    upsertPin(store.db, { scope: 'file', target_id: 'src/foo.ts' });
    const del = deletePin(store.db, { scope: 'file', target_id: 'src/foo.ts' });
    expect(del.deleted).toBe(1);
    expect(listPins(store.db)).toHaveLength(0);
  });

  it('prunes expired pins on read', () => {
    upsertPin(store.db, { scope: 'file', target_id: 'src/old.ts', expires_in_ms: -1000 });
    upsertPin(store.db, { scope: 'file', target_id: 'src/new.ts' });
    const pins = listPins(store.db);
    expect(pins.map((p) => p.target_id)).toEqual(['src/new.ts']);
  });
});

describe('ranking pins — PageRank integration', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    invalidatePinsCache();
    invalidatePageRankCache();
  });

  it('pinning a file boosts its rank in get_pagerank output, unpinning restores baseline', () => {
    // Build a small graph: a, b, c all import "common.ts". Without pins
    // common.ts wins; we then pin a leaf node to push it above common.ts.
    const fCommon = insertFile(store, 'src/common.ts');
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const fC = insertFile(store, 'src/c.ts');
    const fLeaf = insertFile(store, 'src/leaf.ts');

    const nCommon = store.getNodeId('file', fCommon)!;
    const nA = store.getNodeId('file', fA)!;
    const nB = store.getNodeId('file', fB)!;
    const nC = store.getNodeId('file', fC)!;
    const nLeaf = store.getNodeId('file', fLeaf)!;

    insertEdge(store, nA, nCommon, 'esm_imports');
    insertEdge(store, nB, nCommon, 'esm_imports');
    insertEdge(store, nC, nCommon, 'esm_imports');
    // leaf imports a — gives it a tiny non-zero baseline so the comparison
    // is meaningful but common.ts still wins by a comfortable margin.
    insertEdge(store, nLeaf, nA, 'esm_imports');

    const baseline = getPageRank(store);
    const baselineCommon = baseline.find((r) => r.file === 'src/common.ts')!;
    const baselineLeaf = baseline.find((r) => r.file === 'src/leaf.ts')!;
    expect(baselineCommon.score).toBeGreaterThan(baselineLeaf.score);

    // Pin the leaf at max weight; the post-rank multiplier should boost the
    // raw score by exactly the weight factor, lifting it above its baseline.
    upsertPin(store.db, { scope: 'file', target_id: 'src/leaf.ts', weight: 3.0 });
    invalidatePageRankCache();
    const boosted = getPageRank(store);
    const boostedLeaf = boosted.find((r) => r.file === 'src/leaf.ts')!;
    expect(boostedLeaf.score).toBeGreaterThan(baselineLeaf.score);
    // The pin should approximately multiply the baseline score by the weight.
    expect(boostedLeaf.score).toBeCloseTo(baselineLeaf.score * 3.0, 4);

    // The leaf's position should have improved (lower index = better rank).
    const baselineLeafIdx = baseline.findIndex((r) => r.file === 'src/leaf.ts');
    const boostedLeafIdx = boosted.findIndex((r) => r.file === 'src/leaf.ts');
    expect(boostedLeafIdx).toBeLessThanOrEqual(baselineLeafIdx);

    // Unpin restores the baseline ordering and the original raw score.
    deletePin(store.db, { scope: 'file', target_id: 'src/leaf.ts' });
    invalidatePageRankCache();
    const restored = getPageRank(store);
    const restoredCommon = restored.find((r) => r.file === 'src/common.ts')!;
    const restoredLeaf = restored.find((r) => r.file === 'src/leaf.ts')!;
    expect(restoredCommon.score).toBeGreaterThan(restoredLeaf.score);
    expect(restoredLeaf.score).toBeCloseTo(baselineLeaf.score, 4);
  });

  it('weights < 1.0 demote a previously-central file', () => {
    const fCommon = insertFile(store, 'src/common.ts');
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');

    const nCommon = store.getNodeId('file', fCommon)!;
    const nA = store.getNodeId('file', fA)!;
    const nB = store.getNodeId('file', fB)!;

    insertEdge(store, nA, nCommon, 'esm_imports');
    insertEdge(store, nB, nCommon, 'esm_imports');

    const baseline = getPageRank(store);
    const baselineScore = baseline.find((r) => r.file === 'src/common.ts')!.score;

    upsertPin(store.db, { scope: 'file', target_id: 'src/common.ts', weight: 0.5 });
    invalidatePageRankCache();
    const demoted = getPageRank(store);
    const demotedScore = demoted.find((r) => r.file === 'src/common.ts')!.score;
    expect(demotedScore).toBeLessThan(baselineScore);
  });
});
