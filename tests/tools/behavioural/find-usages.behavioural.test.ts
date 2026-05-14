/**
 * Behavioural coverage for `findReferences()` (the `find_usages` MCP tool).
 * Asserts the shape of references, scoping by symbol_id vs file_path, and
 * empty-result contract.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { findReferences } from '../../../src/tools/framework/references.js';
import { createTestStore } from '../../test-utils.js';

interface Seeded {
  store: Store;
  targetSymbolId: string;
  callerSymbolId: string;
  isolatedSymbolId: string;
  callerFile: string;
}

function seed(): Seeded {
  const store = createTestStore();

  // Target: a function `compute()` in math.ts that we will look up usages of.
  const mathFileId = store.insertFile('src/math.ts', 'typescript', 'h1', 200);
  const computeSymRow = store.insertSymbol(mathFileId, {
    symbolId: 'src/math.ts::compute#function',
    name: 'compute',
    kind: 'function',
    fqn: 'compute',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 10,
  });

  // Caller file with a function that calls `compute()`.
  const callerFileId = store.insertFile('src/caller.ts', 'typescript', 'h2', 300);
  const callerSymRow = store.insertSymbol(callerFileId, {
    symbolId: 'src/caller.ts::runJob#function',
    name: 'runJob',
    kind: 'function',
    fqn: 'runJob',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 15,
  });

  // Isolated symbol — no incoming edges, exercises empty-list path.
  const isoFileId = store.insertFile('src/isolated.ts', 'typescript', 'h3', 100);
  store.insertSymbol(isoFileId, {
    symbolId: 'src/isolated.ts::unusedFn#function',
    name: 'unusedFn',
    kind: 'function',
    fqn: 'unusedFn',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 5,
  });

  // Build the graph edge: runJob -> compute (calls).
  const callerNid = store.getNodeId('symbol', callerSymRow);
  const computeNid = store.getNodeId('symbol', computeSymRow);
  if (callerNid != null && computeNid != null) {
    store.insertEdge(callerNid, computeNid, 'calls', true, undefined, false, 'ast_resolved');
  }

  return {
    store,
    targetSymbolId: 'src/math.ts::compute#function',
    callerSymbolId: 'src/caller.ts::runJob#function',
    isolatedSymbolId: 'src/isolated.ts::unusedFn#function',
    callerFile: 'src/caller.ts',
  };
}

describe('findReferences() — behavioural contract', () => {
  let ctx: Seeded;

  beforeEach(() => {
    ctx = seed();
  });

  it('basic symbol_id lookup finds incoming reference sites', () => {
    const result = findReferences(ctx.store, { symbolId: ctx.targetSymbolId });
    expect(result.isOk()).toBe(true);
    const refs = result._unsafeUnwrap();
    expect(refs.total).toBeGreaterThan(0);
    expect(refs.references.length).toBe(refs.total);
  });

  it('reference items have file + edge_type + resolution_tier', () => {
    const result = findReferences(ctx.store, { symbolId: ctx.targetSymbolId });
    expect(result.isOk()).toBe(true);
    for (const ref of result._unsafeUnwrap().references) {
      expect(typeof ref.file).toBe('string');
      expect(typeof ref.edge_type).toBe('string');
      expect(typeof ref.resolution_tier).toBe('string');
    }
  });

  it('returns empty references for a symbol with no incoming edges', () => {
    const result = findReferences(ctx.store, { symbolId: ctx.isolatedSymbolId });
    expect(result.isOk()).toBe(true);
    const refs = result._unsafeUnwrap();
    expect(refs.total).toBe(0);
    expect(refs.references).toEqual([]);
  });

  it('file_path lookup returns incoming references targeting the file node', () => {
    // The fixture only wires symbol→symbol edges (no file-level edges).
    // file_path mode should still resolve cleanly and return an empty list
    // rather than throwing — that is the documented contract.
    const result = findReferences(ctx.store, { filePath: 'src/math.ts' });
    expect(result.isOk()).toBe(true);
    const refs = result._unsafeUnwrap();
    expect(Array.isArray(refs.references)).toBe(true);
    expect(typeof refs.total).toBe('number');
  });

  it('honours includeAmbiguousTextMatched flag without errors', () => {
    const off = findReferences(ctx.store, {
      symbolId: ctx.targetSymbolId,
      includeAmbiguousTextMatched: false,
    });
    const on = findReferences(ctx.store, {
      symbolId: ctx.targetSymbolId,
      includeAmbiguousTextMatched: true,
    });
    expect(off.isOk()).toBe(true);
    expect(on.isOk()).toBe(true);
    // With the flag on, total must be >= off (we never drop *more* refs
    // when ambiguous ones are kept).
    expect(on._unsafeUnwrap().total).toBeGreaterThanOrEqual(off._unsafeUnwrap().total);
  });

  it('unknown symbol_id surfaces NOT_FOUND error', () => {
    const result = findReferences(ctx.store, { symbolId: 'src/nope.ts::missing#function' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });
});
