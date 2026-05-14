/**
 * Behavioural coverage for `getPageRank()`. Seeds a file-level import graph
 * with one "hub" file that has many incoming `esm_imports` edges and verifies:
 *   - hub outranks isolated/leaf files
 *   - output shape includes file/score/in_degree/out_degree, sorted desc
 *   - file-scope ranking pin lifts a file's score
 *   - symbol-scope ranking pin propagates to its containing file (M1)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { invalidatePinsCache } from '../../../src/scoring/pins.js';
import { getPageRank } from '../../../src/tools/analysis/graph-analysis.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
  hubPath: string;
  leafPath: string;
  pinTargetPath: string;
  pinSymbolId: string;
  pinSymbolFilePath: string;
}

function insertFileWithSymbol(
  store: Store,
  path: string,
  symbolName: string,
): { fileNodeId: number; symbolId: string } {
  const fid = store.insertFile(path, 'typescript', `h-${path}`, 100);
  const symRow = store.insertSymbol(fid, {
    symbolId: `${path}::${symbolName}#function`,
    name: symbolName,
    kind: 'function',
    fqn: symbolName,
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 3,
  });
  // Returned IDs are used for wiring file-level imports.
  const fileNodeId = store.getNodeId('file', fid)!;
  void symRow;
  return { fileNodeId, symbolId: `${path}::${symbolName}#function` };
}

/**
 * Hub topology:
 *   src/spoke1.ts → src/hub.ts
 *   src/spoke2.ts → src/hub.ts
 *   src/spoke3.ts → src/hub.ts
 *   src/leaf.ts   (no edges)
 *   src/pinTarget.ts (no edges — used for pin tests)
 *   src/pinSymbolFile.ts (one symbol — used for symbol-pin propagation)
 */
function seed(): Fixture {
  const store = createTestStore();

  const hub = insertFileWithSymbol(store, 'src/hub.ts', 'hubFn');
  const spoke1 = insertFileWithSymbol(store, 'src/spoke1.ts', 's1Fn');
  const spoke2 = insertFileWithSymbol(store, 'src/spoke2.ts', 's2Fn');
  const spoke3 = insertFileWithSymbol(store, 'src/spoke3.ts', 's3Fn');
  insertFileWithSymbol(store, 'src/leaf.ts', 'leafFn');
  insertFileWithSymbol(store, 'src/pinTarget.ts', 'pinTargetFn');
  const pinSymbolFile = insertFileWithSymbol(store, 'src/pinSymbolFile.ts', 'pinnableFn');

  // File-level imports: spokeN -> hub. buildFileGraph picks these up because
  // it joins node_type='file' rows directly via CASE.
  for (const spoke of [spoke1, spoke2, spoke3]) {
    store.insertEdge(
      spoke.fileNodeId,
      hub.fileNodeId,
      'esm_imports',
      true,
      undefined,
      false,
      'ast_resolved',
    );
  }

  return {
    store,
    hubPath: 'src/hub.ts',
    leafPath: 'src/leaf.ts',
    pinTargetPath: 'src/pinTarget.ts',
    pinSymbolId: pinSymbolFile.symbolId,
    pinSymbolFilePath: 'src/pinSymbolFile.ts',
  };
}

function rankOf(results: Array<{ file: string }>, file: string): number {
  return results.findIndex((r) => r.file === file);
}

describe('getPageRank() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    // pins.ts holds a 30s in-process cache. Clear it between tests so writes
    // to ranking_pins are observed by the next getPageRank() call.
    invalidatePinsCache();
    ctx = seed();
  });

  it('returns sorted array with file/score/in_degree/out_degree fields', () => {
    const results = getPageRank(ctx.store);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.file).toBe('string');
      expect(typeof r.score).toBe('number');
      expect(typeof r.in_degree).toBe('number');
      expect(typeof r.out_degree).toBe('number');
    }
    // Sorted descending by score.
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('hub with many incoming imports outranks an isolated leaf', () => {
    const results = getPageRank(ctx.store);
    const hub = results.find((r) => r.file === ctx.hubPath);
    expect(hub).toBeDefined();
    expect(hub!.in_degree).toBe(3);
    // The hub should land first (highest score) in this topology.
    expect(results[0].file).toBe(ctx.hubPath);
    // Leaf is isolated → may not even appear (buildFileGraph skips files with no edges).
    const leafRank = rankOf(results, ctx.leafPath);
    if (leafRank !== -1) {
      expect(hub!.score).toBeGreaterThan(results[leafRank].score);
    }
  });

  it('an explicit file pin (weight=3) lifts that file in the ranking', () => {
    // Reuse spoke1 (which already has out_degree=1, score after first iteration ~equal to other spokes).
    const before = getPageRank(ctx.store);
    const beforeRank = rankOf(before, 'src/spoke1.ts');
    expect(beforeRank).toBeGreaterThanOrEqual(0);

    ctx.store.db
      .prepare(
        `INSERT INTO ranking_pins (scope, target_id, weight, expires_at, created_by, created_at)
         VALUES ('file', ?, 3.0, NULL, 'test', ?)`,
      )
      .run('src/spoke1.ts', Date.now());
    invalidatePinsCache();

    const after = getPageRank(ctx.store);
    const afterRank = rankOf(after, 'src/spoke1.ts');
    expect(afterRank).toBeGreaterThanOrEqual(0);

    const beforeScore = before[beforeRank].score;
    const afterScore = after[afterRank].score;
    expect(afterScore).toBeGreaterThan(beforeScore);
  });

  it('symbol-scope pin propagates to the containing file (M1 wiring)', () => {
    // pinSymbolFile is isolated → it will NOT show in buildFileGraph because
    // there are no edges. To exercise symbol-pin propagation we connect it
    // first, then assert the pin amplifies its score.
    const filesRow = ctx.store.db
      .prepare(`SELECT id FROM files WHERE path = ?`)
      .get(ctx.pinSymbolFilePath) as { id: number };
    const hubFileRow = ctx.store.db
      .prepare(`SELECT id FROM files WHERE path = ?`)
      .get(ctx.hubPath) as { id: number };
    const fileNodeId = ctx.store.getNodeId('file', filesRow.id)!;
    const hubNodeId = ctx.store.getNodeId('file', hubFileRow.id)!;
    // Make pinSymbolFile a spoke of hub so it lands in the file graph.
    ctx.store.insertEdge(
      fileNodeId,
      hubNodeId,
      'esm_imports',
      true,
      undefined,
      false,
      'ast_resolved',
    );

    const before = getPageRank(ctx.store);
    const beforeRow = before.find((r) => r.file === ctx.pinSymbolFilePath);
    expect(beforeRow).toBeDefined();

    ctx.store.db
      .prepare(
        `INSERT INTO ranking_pins (scope, target_id, weight, expires_at, created_by, created_at)
         VALUES ('symbol', ?, 3.0, NULL, 'test', ?)`,
      )
      .run(ctx.pinSymbolId, Date.now());
    invalidatePinsCache();

    const after = getPageRank(ctx.store);
    const afterRow = after.find((r) => r.file === ctx.pinSymbolFilePath);
    expect(afterRow).toBeDefined();
    expect(afterRow!.score).toBeGreaterThan(beforeRow!.score);
  });

  it('explicit file pin wins over symbol pin propagation', () => {
    // Make pinTarget participate in the graph so it shows up.
    const pinTargetFileRow = ctx.store.db
      .prepare(`SELECT id FROM files WHERE path = ?`)
      .get(ctx.pinTargetPath) as { id: number };
    const hubFileRow = ctx.store.db
      .prepare(`SELECT id FROM files WHERE path = ?`)
      .get(ctx.hubPath) as { id: number };
    const fNode = ctx.store.getNodeId('file', pinTargetFileRow.id)!;
    const hNode = ctx.store.getNodeId('file', hubFileRow.id)!;
    ctx.store.insertEdge(fNode, hNode, 'esm_imports', true, undefined, false, 'ast_resolved');

    // First: insert a symbol pin (weight 3) on pinTargetFn — would normally amplify.
    ctx.store.db
      .prepare(
        `INSERT INTO ranking_pins (scope, target_id, weight, expires_at, created_by, created_at)
         VALUES ('symbol', ?, 3.0, NULL, 'test', ?)`,
      )
      .run('src/pinTarget.ts::pinTargetFn#function', Date.now());

    // Then an explicit file pin at 0.5 (demote). Per pins.ts precedence, file pin wins.
    ctx.store.db
      .prepare(
        `INSERT INTO ranking_pins (scope, target_id, weight, expires_at, created_by, created_at)
         VALUES ('file', ?, 0.5, NULL, 'test', ?)`,
      )
      .run(ctx.pinTargetPath, Date.now());
    invalidatePinsCache();

    const results = getPageRank(ctx.store);
    const target = results.find((r) => r.file === ctx.pinTargetPath);
    expect(target).toBeDefined();
    // It should still appear, but demoted — its score must be less than the hub's.
    const hub = results.find((r) => r.file === ctx.hubPath);
    expect(target!.score).toBeLessThan(hub!.score);
  });

  it('empty graph returns empty array (no crash)', () => {
    const empty = createTestStore();
    const results = getPageRank(empty);
    expect(results).toEqual([]);
  });
});
