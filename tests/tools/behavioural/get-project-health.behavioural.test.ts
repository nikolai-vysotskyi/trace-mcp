/**
 * Behavioural coverage for `getRepoHealth()` in
 * `src/tools/analysis/graph-analysis.ts` (the implementation behind the
 * `get_project_health` MCP tool). Aggregates coupling, cycles, pagerank
 * rankings, and extraction candidates into one envelope.
 *
 * Output shape:
 *   { summary: { total_files, total_symbols, files_in_graph,
 *                dependency_cycles, unstable_modules, avg_instability },
 *     top_pagerank: PageRankResult[],
 *     cycles: { files: string[], length: number }[],
 *     most_unstable: CouplingResult[],
 *     extraction_candidates: ExtractionCandidate[] }
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getRepoHealth } from '../../../src/tools/analysis/graph-analysis.js';
import { createTestStore } from '../../test-utils.js';

function insertFileWithSymbol(
  store: Store,
  path: string,
  name: string,
): {
  fileId: number;
  fileNodeId: number;
} {
  const fileId = store.insertFile(path, 'typescript', `h-${path}`, 100);
  store.insertSymbol(fileId, {
    symbolId: `${path}::${name}#function`,
    name,
    kind: 'function',
    fqn: name,
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
  });
  return { fileId, fileNodeId: store.getNodeId('file', fileId)! };
}

describe('getRepoHealth() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('empty index → empty arrays + zeroed summary, no throw', () => {
    const result = getRepoHealth(store);
    expect(result.summary.total_files).toBe(0);
    expect(result.summary.total_symbols).toBe(0);
    expect(result.summary.files_in_graph).toBe(0);
    expect(result.summary.dependency_cycles).toBe(0);
    expect(result.summary.unstable_modules).toBe(0);
    expect(result.top_pagerank).toEqual([]);
    expect(result.cycles).toEqual([]);
    expect(result.most_unstable).toEqual([]);
    expect(result.extraction_candidates).toEqual([]);
  });

  it('envelope contains every documented top-level key', () => {
    const result = getRepoHealth(store);
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('top_pagerank');
    expect(result).toHaveProperty('cycles');
    expect(result).toHaveProperty('most_unstable');
    expect(result).toHaveProperty('extraction_candidates');
    for (const k of [
      'total_files',
      'total_symbols',
      'files_in_graph',
      'dependency_cycles',
      'unstable_modules',
      'avg_instability',
    ]) {
      expect(result.summary).toHaveProperty(k);
    }
  });

  it('top_pagerank rows carry file / score / in_degree / out_degree sorted desc', () => {
    const hub = insertFileWithSymbol(store, 'src/hub.ts', 'hub');
    for (let i = 0; i < 3; i++) {
      const spoke = insertFileWithSymbol(store, `src/s${i}.ts`, `s${i}`);
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

    const result = getRepoHealth(store);
    expect(result.top_pagerank.length).toBeGreaterThan(0);
    for (const row of result.top_pagerank) {
      expect(typeof row.file).toBe('string');
      expect(typeof row.score).toBe('number');
      expect(typeof row.in_degree).toBe('number');
      expect(typeof row.out_degree).toBe('number');
    }
    for (let i = 1; i < result.top_pagerank.length; i++) {
      expect(result.top_pagerank[i - 1].score).toBeGreaterThanOrEqual(result.top_pagerank[i].score);
    }
    expect(result.top_pagerank[0].file).toBe('src/hub.ts');
  });

  it('most_unstable entries are CouplingResult-shaped (file + ca + ce + instability)', () => {
    // Build an unstable file: imports many things (high Ce) but is imported by none (Ca=0)
    // → instability 1.0.
    const unstable = insertFileWithSymbol(store, 'src/unstable.ts', 'unstableFn');
    for (let i = 0; i < 5; i++) {
      const target = insertFileWithSymbol(store, `src/dep${i}.ts`, `dep${i}`);
      store.insertEdge(
        unstable.fileNodeId,
        target.fileNodeId,
        'esm_imports',
        true,
        undefined,
        false,
        'ast_resolved',
      );
    }

    const result = getRepoHealth(store);
    for (const c of result.most_unstable) {
      expect(typeof c.file).toBe('string');
      expect(typeof c.ca).toBe('number');
      expect(typeof c.ce).toBe('number');
      expect(typeof c.instability).toBe('number');
      expect(c.assessment).toBe('unstable');
    }
    // summary.unstable_modules should reflect the count of unstable entries.
    expect(result.summary.unstable_modules).toBeGreaterThanOrEqual(result.most_unstable.length);
  });

  it('cycles is an array of { files: string[], length: number } entries', () => {
    // Wire a 2-file cycle: a -> b -> a.
    const a = insertFileWithSymbol(store, 'src/a.ts', 'aFn');
    const b = insertFileWithSymbol(store, 'src/b.ts', 'bFn');
    store.insertEdge(
      a.fileNodeId,
      b.fileNodeId,
      'esm_imports',
      true,
      undefined,
      false,
      'ast_resolved',
    );
    store.insertEdge(
      b.fileNodeId,
      a.fileNodeId,
      'esm_imports',
      true,
      undefined,
      false,
      'ast_resolved',
    );

    const result = getRepoHealth(store);
    expect(Array.isArray(result.cycles)).toBe(true);
    expect(result.cycles.length).toBeGreaterThan(0);
    for (const cycle of result.cycles) {
      expect(Array.isArray(cycle.files)).toBe(true);
      expect(cycle.files.length).toBeGreaterThanOrEqual(2);
      for (const file of cycle.files) {
        expect(typeof file).toBe('string');
      }
      expect(typeof cycle.length).toBe('number');
    }
    expect(result.summary.dependency_cycles).toBe(result.cycles.length);
  });
});
