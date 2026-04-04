import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../../src/db/store.js';
import { initializeDatabase } from '../../src/db/schema.js';
import {
  getCouplingMetrics,
  getDependencyCycles,
  getPageRank,
  getExtractionCandidates,
  getRepoHealth,
} from '../../src/tools/graph-analysis.js';

function createStore(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

function insertFile(store: Store, path: string, lang = 'typescript'): number {
  return store.insertFile(path, lang, 'hash_' + path, 100);
}

function insertSymbol(
  store: Store,
  fileId: number,
  name: string,
  kind = 'function',
  metadata?: Record<string, unknown>,
): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:${name}`,
    name,
    kind,
    byteStart: 0,
    byteEnd: 100,
    metadata,
  });
}

function insertEdge(store: Store, srcNodeId: number, tgtNodeId: number, edgeType: string): void {
  store.insertEdge(srcNodeId, tgtNodeId, edgeType);
}

describe('getCouplingMetrics', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
  });

  it('returns empty for no files', () => {
    const result = getCouplingMetrics(store);
    expect(result).toEqual([]);
  });

  it('computes Ca/Ce/Instability correctly', () => {
    // A imports B, A imports C → A has Ce=2, B has Ca=1, C has Ca=1
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const fC = insertFile(store, 'src/c.ts');

    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    const nodeC = store.getNodeId('file', fC)!;

    insertEdge(store, nodeA, nodeB, 'esm_imports');
    insertEdge(store, nodeA, nodeC, 'esm_imports');

    const result = getCouplingMetrics(store);
    expect(result.length).toBe(3);

    const a = result.find((r) => r.file === 'src/a.ts')!;
    expect(a.ce).toBe(2);
    expect(a.ca).toBe(0);
    expect(a.instability).toBe(1); // Ce/(Ca+Ce) = 2/2 = 1
    expect(a.assessment).toBe('unstable');

    const b = result.find((r) => r.file === 'src/b.ts')!;
    expect(b.ca).toBe(1);
    expect(b.ce).toBe(0);
    expect(b.instability).toBe(0);
    expect(b.assessment).toBe('stable');
  });
});

describe('getDependencyCycles', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
  });

  it('returns empty when no cycles', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    insertEdge(store, nodeA, nodeB, 'esm_imports');

    const cycles = getDependencyCycles(store);
    expect(cycles).toEqual([]);
  });

  it('detects a simple cycle A→B→A', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;

    insertEdge(store, nodeA, nodeB, 'esm_imports');
    insertEdge(store, nodeB, nodeA, 'esm_imports');

    const cycles = getDependencyCycles(store);
    expect(cycles.length).toBe(1);
    expect(cycles[0].length).toBe(2);
    expect(cycles[0].files).toContain('src/a.ts');
    expect(cycles[0].files).toContain('src/b.ts');
  });

  it('detects a 3-node cycle A→B→C→A', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const fC = insertFile(store, 'src/c.ts');
    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    const nodeC = store.getNodeId('file', fC)!;

    insertEdge(store, nodeA, nodeB, 'esm_imports');
    insertEdge(store, nodeB, nodeC, 'esm_imports');
    insertEdge(store, nodeC, nodeA, 'esm_imports');

    const cycles = getDependencyCycles(store);
    expect(cycles.length).toBe(1);
    expect(cycles[0].length).toBe(3);
  });
});

describe('getPageRank', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
  });

  it('returns empty for no files', () => {
    expect(getPageRank(store)).toEqual([]);
  });

  it('ranks files by importance', () => {
    // Hub: B is imported by A, C, D → B should have highest rank
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const fC = insertFile(store, 'src/c.ts');
    const fD = insertFile(store, 'src/d.ts');

    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    const nodeC = store.getNodeId('file', fC)!;
    const nodeD = store.getNodeId('file', fD)!;

    insertEdge(store, nodeA, nodeB, 'esm_imports');
    insertEdge(store, nodeC, nodeB, 'esm_imports');
    insertEdge(store, nodeD, nodeB, 'esm_imports');

    const results = getPageRank(store);
    expect(results.length).toBe(4);

    // B should be ranked first (highest PageRank)
    expect(results[0].file).toBe('src/b.ts');
    expect(results[0].in_degree).toBe(3);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('all scores sum to approximately 1', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    insertEdge(store, nodeA, nodeB, 'esm_imports');

    const results = getPageRank(store);
    const totalScore = results.reduce((sum, r) => sum + r.score, 0);
    expect(totalScore).toBeCloseTo(1, 2);
  });
});

describe('getExtractionCandidates', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
  });

  it('returns empty when no complex functions', () => {
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'simpleFunc', 'function', { cyclomatic: 2 });
    expect(getExtractionCandidates(store)).toEqual([]);
  });

  it('finds complex functions called from multiple files', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const fC = insertFile(store, 'src/c.ts');

    const symId = insertSymbol(store, fA, 'complexFunc', 'function', { cyclomatic: 10 });
    const symNodeId = store.getNodeId('symbol', symId)!;

    // B and C both call complexFunc
    const nodeB = store.getNodeId('file', fB)!;
    const nodeC = store.getNodeId('file', fC)!;
    insertEdge(store, nodeB, symNodeId, 'calls');
    insertEdge(store, nodeC, symNodeId, 'calls');

    const results = getExtractionCandidates(store, { minCyclomatic: 5, minCallers: 2 });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('complexFunc');
    expect(results[0].cyclomatic).toBe(10);
    expect(results[0].caller_file_count).toBe(2);
    expect(results[0].score).toBe(20);
  });
});

describe('getRepoHealth', () => {
  it('returns aggregated health report', () => {
    const store = createStore();
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    insertEdge(store, nodeA, nodeB, 'esm_imports');

    const result = getRepoHealth(store);
    expect(result.summary.total_files).toBe(2);
    expect(result.summary.dependency_cycles).toBe(0);
    expect(result.top_pagerank.length).toBe(2);
    expect(result.cycles).toEqual([]);
  });
});
