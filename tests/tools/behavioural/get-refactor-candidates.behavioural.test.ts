/**
 * Behavioural coverage for `getExtractionCandidates()` in
 * `src/tools/analysis/graph-analysis.ts` (the implementation behind the
 * `get_refactor_candidates` MCP tool). Finds complex symbols (cyclomatic
 * >= minCyclomatic) that are called from >= minCallers distinct files,
 * sorted by `cyclomatic * caller_file_count` descending.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getExtractionCandidates } from '../../../src/tools/analysis/graph-analysis.js';
import { createTestStore } from '../../test-utils.js';

function insertFile(store: Store, filePath: string): number {
  return store.insertFile(filePath, 'typescript', `h-${filePath}`, 100);
}

/**
 * Insert a function/method symbol with a stored `cyclomatic` metadata
 * value — the indexer normalizes this to the `cyclomatic` column.
 */
function insertFn(
  store: Store,
  fileId: number,
  name: string,
  cyclomatic: number,
  kind: 'function' | 'method' = 'function',
): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:${name}`,
    name,
    kind,
    byteStart: 0,
    byteEnd: 100,
    metadata: { cyclomatic },
  });
}

/**
 * Wire `callerFileId` -> `targetSymbolNodeId` as a `calls` edge — counted
 * by getExtractionCandidates as one distinct caller file.
 */
function wireCallerFile(store: Store, callerFileId: number, targetSymbolId: number): void {
  const fileNode = store.getNodeId('file', callerFileId)!;
  const symNode = store.getNodeId('symbol', targetSymbolId)!;
  store.insertEdge(fileNode, symNode, 'calls');
}

describe('getExtractionCandidates() — behavioural contract (get_refactor_candidates)', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns shape { symbol_id, name, file, cyclomatic, caller_file_count, score }', () => {
    const fTarget = insertFile(store, 'src/target.ts');
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const sym = insertFn(store, fTarget, 'hotFn', 10);
    wireCallerFile(store, fA, sym);
    wireCallerFile(store, fB, sym);

    const results = getExtractionCandidates(store, { minCyclomatic: 5, minCallers: 2 });
    expect(results.length).toBe(1);
    const c = results[0];
    expect(c.symbol_id).toBe('sym:hotFn');
    expect(c.name).toBe('hotFn');
    expect(c.file).toBe('src/target.ts');
    expect(c.cyclomatic).toBe(10);
    expect(c.caller_file_count).toBe(2);
    // score = cyclomatic * caller_file_count
    expect(c.score).toBe(20);
  });

  it('is sorted by `cyclomatic * caller_file_count` descending', () => {
    const fTarget = insertFile(store, 'src/target.ts');
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const fC = insertFile(store, 'src/c.ts');

    // Lower combined score (5 * 2 = 10)
    const small = insertFn(store, fTarget, 'small', 5);
    wireCallerFile(store, fA, small);
    wireCallerFile(store, fB, small);

    // Higher combined score (8 * 3 = 24)
    const big = insertFn(store, fTarget, 'big', 8);
    wireCallerFile(store, fA, big);
    wireCallerFile(store, fB, big);
    wireCallerFile(store, fC, big);

    const results = getExtractionCandidates(store, { minCyclomatic: 5, minCallers: 2 });
    expect(results.map((r) => r.name)).toEqual(['big', 'small']);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('minCyclomatic filter excludes simpler symbols', () => {
    const fTarget = insertFile(store, 'src/target.ts');
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');

    // Below threshold (cyclomatic=3, threshold=5) — should be excluded.
    const simple = insertFn(store, fTarget, 'simple', 3);
    wireCallerFile(store, fA, simple);
    wireCallerFile(store, fB, simple);

    // At threshold — should appear.
    const complex = insertFn(store, fTarget, 'complex', 7);
    wireCallerFile(store, fA, complex);
    wireCallerFile(store, fB, complex);

    const results = getExtractionCandidates(store, { minCyclomatic: 5, minCallers: 2 });
    expect(results.map((r) => r.name)).toEqual(['complex']);
  });

  it('minCallers filter excludes infrequently-called symbols', () => {
    const fTarget = insertFile(store, 'src/target.ts');
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const fC = insertFile(store, 'src/c.ts');

    // Called from only one external file — excluded by minCallers=2.
    const seldom = insertFn(store, fTarget, 'seldom', 9);
    wireCallerFile(store, fA, seldom);

    // Called from two external files — included.
    const often = insertFn(store, fTarget, 'often', 9);
    wireCallerFile(store, fB, often);
    wireCallerFile(store, fC, often);

    const results = getExtractionCandidates(store, { minCyclomatic: 5, minCallers: 2 });
    expect(results.map((r) => r.name)).toEqual(['often']);
  });

  it('limit caps the number of returned candidates', () => {
    const fTarget = insertFile(store, 'src/target.ts');
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');

    // Seed 5 candidates with descending complexity so order is predictable.
    for (let i = 0; i < 5; i++) {
      const sym = insertFn(store, fTarget, `fn${i}`, 20 - i);
      wireCallerFile(store, fA, sym);
      wireCallerFile(store, fB, sym);
    }

    const results = getExtractionCandidates(store, {
      minCyclomatic: 5,
      minCallers: 2,
      limit: 2,
    });
    expect(results.length).toBe(2);
    // Highest-complexity (fn0, cyclo=20) first.
    expect(results[0].name).toBe('fn0');
    expect(results[1].name).toBe('fn1');
  });

  it('empty index returns an empty array', () => {
    const empty = createTestStore();
    expect(getExtractionCandidates(empty)).toEqual([]);
  });
});
