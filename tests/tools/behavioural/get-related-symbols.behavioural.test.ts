/**
 * Behavioural coverage for `getRelatedSymbols()`. Verifies the three signal
 * channels — co-location, shared importers, name overlap — and the basic
 * output contract.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getRelatedSymbols } from '../../../src/tools/navigation/related.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
  targetSymbolId: string;
  siblingSymbolId: string;
  coImportedSymbolId: string;
}

/**
 * Topology:
 *   src/target.ts
 *     targetFn (the symbol we query around)
 *     siblingFn (co-located → relation 'co_location')
 *   src/co-imported.ts
 *     coImportedFn (a symbol in a different file that shares importers with target.ts)
 *   src/caller.ts
 *     imports both src/target.ts AND src/co-imported.ts → shared importer signal
 */
function seed(): Fixture {
  const store = createTestStore();

  const targetFid = store.insertFile('src/target.ts', 'typescript', 'h-t', 200);
  store.insertSymbol(targetFid, {
    symbolId: 'src/target.ts::targetFn#function',
    name: 'targetFn',
    kind: 'function',
    fqn: 'targetFn',
    byteStart: 0,
    byteEnd: 60,
    lineStart: 1,
    lineEnd: 8,
  });
  store.insertSymbol(targetFid, {
    symbolId: 'src/target.ts::siblingFn#function',
    name: 'siblingFn',
    kind: 'function',
    fqn: 'siblingFn',
    byteStart: 60,
    byteEnd: 100,
    lineStart: 9,
    lineEnd: 15,
  });

  const coFid = store.insertFile('src/co-imported.ts', 'typescript', 'h-co', 100);
  store.insertSymbol(coFid, {
    symbolId: 'src/co-imported.ts::coImportedFn#function',
    name: 'coImportedFn',
    kind: 'function',
    fqn: 'coImportedFn',
    byteStart: 0,
    byteEnd: 40,
    lineStart: 1,
    lineEnd: 5,
  });

  // The caller imports BOTH files, so they share an importer.
  const callerFid = store.insertFile('src/caller.ts', 'typescript', 'h-cl', 100);
  store.insertSymbol(callerFid, {
    symbolId: 'src/caller.ts::useBoth#function',
    name: 'useBoth',
    kind: 'function',
    fqn: 'useBoth',
    byteStart: 0,
    byteEnd: 40,
    lineStart: 1,
    lineEnd: 5,
  });

  // File-level imports: caller → target, caller → co-imported. These match
  // the et.name IN ('esm_imports','imports','py_imports','py_reexports')
  // filter in the shared-importer SQL.
  const callerFileNode = store.getNodeId('file', callerFid)!;
  const targetFileNode = store.getNodeId('file', targetFid)!;
  const coFileNode = store.getNodeId('file', coFid)!;
  store.insertEdge(
    callerFileNode,
    targetFileNode,
    'esm_imports',
    true,
    undefined,
    false,
    'ast_resolved',
  );
  store.insertEdge(
    callerFileNode,
    coFileNode,
    'esm_imports',
    true,
    undefined,
    false,
    'ast_resolved',
  );

  return {
    store,
    targetSymbolId: 'src/target.ts::targetFn#function',
    siblingSymbolId: 'src/target.ts::siblingFn#function',
    coImportedSymbolId: 'src/co-imported.ts::coImportedFn#function',
  };
}

describe('getRelatedSymbols() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('returns target + related[] envelope with proper item shape', () => {
    const result = getRelatedSymbols(ctx.store, { symbolId: ctx.targetSymbolId });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.target.symbol_id).toBe(ctx.targetSymbolId);
    expect(data.target.name).toBe('targetFn');
    expect(data.target.file).toBe('src/target.ts');
    expect(Array.isArray(data.related)).toBe(true);
    for (const r of data.related) {
      expect(typeof r.symbol_id).toBe('string');
      expect(typeof r.name).toBe('string');
      expect(typeof r.kind).toBe('string');
      expect(typeof r.file).toBe('string');
      expect(typeof r.score).toBe('number');
      expect(r.signals).toBeDefined();
      expect(typeof r.signals.co_location).toBe('number');
      expect(typeof r.signals.shared_importers).toBe('number');
      expect(typeof r.signals.name_overlap).toBe('number');
    }
  });

  it('co-located sibling appears in related with co_location signal == 1', () => {
    const result = getRelatedSymbols(ctx.store, { symbolId: ctx.targetSymbolId });
    expect(result.isOk()).toBe(true);
    const sibling = result._unsafeUnwrap().related.find((r) => r.symbol_id === ctx.siblingSymbolId);
    expect(sibling).toBeDefined();
    expect(sibling!.signals.co_location).toBe(1);
  });

  it('shared-importer symbol surfaces with non-zero shared_importers signal', () => {
    const result = getRelatedSymbols(ctx.store, { symbolId: ctx.targetSymbolId });
    expect(result.isOk()).toBe(true);
    const co = result._unsafeUnwrap().related.find((r) => r.symbol_id === ctx.coImportedSymbolId);
    expect(co).toBeDefined();
    expect(co!.signals.shared_importers).toBeGreaterThan(0);
  });

  it('maxResults caps the related[] length', () => {
    const result = getRelatedSymbols(ctx.store, {
      symbolId: ctx.targetSymbolId,
      maxResults: 1,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().related.length).toBeLessThanOrEqual(1);
  });

  it('result is sorted by score descending', () => {
    const result = getRelatedSymbols(ctx.store, { symbolId: ctx.targetSymbolId });
    expect(result.isOk()).toBe(true);
    const related = result._unsafeUnwrap().related;
    for (let i = 1; i < related.length; i++) {
      expect(related[i - 1].score).toBeGreaterThanOrEqual(related[i].score);
    }
  });

  it('unknown symbol_id returns NOT_FOUND error', () => {
    const result = getRelatedSymbols(ctx.store, {
      symbolId: 'src/nope.ts::ghost#function',
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });
});
