/**
 * Behavioural coverage for `selfAudit()` in
 * `src/tools/analysis/introspect.ts`. Single aggregated envelope combining
 * dead exports, untested exports, dependency hotspots, heritage, complexity,
 * and unstable modules.
 *
 * Output shape:
 *   { summary: { total_files, total_symbols, total_edges, total_exports,
 *                dead_exports, untested_exports, test_files, import_edges,
 *                heritage_edges, test_covers_edges, dependency_cycles,
 *                unstable_modules, avg_cyclomatic },
 *     dead_exports_top10, untested_top10, most_imported_files,
 *     most_dependent_files, widest_interfaces, most_complex_symbols,
 *     most_unstable }
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { selfAudit } from '../../../src/tools/analysis/introspect.js';
import { createTestStore } from '../../test-utils.js';

function insertExportedSymbol(
  store: Store,
  fileId: number,
  name: string,
  kind: 'class' | 'function' | 'interface' = 'function',
  cyclomatic?: number,
): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:${name}`,
    name,
    kind,
    fqn: name,
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
    metadata: cyclomatic !== undefined ? { exported: true, cyclomatic } : { exported: true },
  });
}

describe('selfAudit() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('empty index → all subarrays empty and summary counts are zero', () => {
    const result = selfAudit(store);

    expect(result.summary.total_files).toBe(0);
    expect(result.summary.total_symbols).toBe(0);
    expect(result.summary.total_edges).toBe(0);
    expect(result.summary.total_exports).toBe(0);
    expect(result.summary.dead_exports).toBe(0);
    expect(result.summary.untested_exports).toBe(0);
    expect(result.summary.dependency_cycles).toBe(0);
    expect(result.summary.unstable_modules).toBe(0);

    expect(result.dead_exports_top10).toEqual([]);
    expect(result.untested_top10).toEqual([]);
    expect(result.most_imported_files).toEqual([]);
    expect(result.most_dependent_files).toEqual([]);
    expect(result.widest_interfaces).toEqual([]);
    expect(result.most_complex_symbols).toEqual([]);
    expect(result.most_unstable).toEqual([]);
  });

  it('dead_exports_top10 entries carry symbol_id / name / kind / file', () => {
    const f = store.insertFile('src/orphan.ts', 'typescript', 'h-o', 50);
    insertExportedSymbol(store, f, 'orphanFn');

    const result = selfAudit(store);
    expect(result.summary.dead_exports).toBeGreaterThan(0);
    expect(result.dead_exports_top10.length).toBeGreaterThan(0);
    const item = result.dead_exports_top10[0];
    expect(typeof item.symbol_id).toBe('string');
    expect(typeof item.name).toBe('string');
    expect(typeof item.kind).toBe('string');
    expect(typeof item.file).toBe('string');
  });

  it('summary counts match the underlying arrays for symbols / files', () => {
    const fA = store.insertFile('src/a.ts', 'typescript', 'h-a', 50);
    const fB = store.insertFile('src/b.ts', 'typescript', 'h-b', 60);
    insertExportedSymbol(store, fA, 'fnA');
    insertExportedSymbol(store, fB, 'fnB');

    const result = selfAudit(store);
    expect(result.summary.total_files).toBe(2);
    expect(result.summary.total_symbols).toBe(2);
    expect(result.summary.total_exports).toBe(2);
    // dead_exports_top10 is capped at 10 — count via summary, not the array.
    expect(result.summary.dead_exports).toBeGreaterThanOrEqual(result.dead_exports_top10.length);
    expect(result.dead_exports_top10.length).toBeLessThanOrEqual(10);
  });

  it('most_complex_symbols sorted by cyclomatic desc', () => {
    const f = store.insertFile('src/complex.ts', 'typescript', 'h-c', 200);
    insertExportedSymbol(store, f, 'low', 'function', 2);
    insertExportedSymbol(store, f, 'mid', 'function', 7);
    insertExportedSymbol(store, f, 'high', 'function', 15);

    const result = selfAudit(store);
    expect(result.most_complex_symbols.length).toBeGreaterThan(0);
    for (let i = 1; i < result.most_complex_symbols.length; i++) {
      expect(result.most_complex_symbols[i - 1].cyclomatic).toBeGreaterThanOrEqual(
        result.most_complex_symbols[i].cyclomatic,
      );
    }
    // 'high' must lead.
    expect(result.most_complex_symbols[0].name).toBe('high');
    // avg_cyclomatic should reflect the inserted symbols.
    expect(result.summary.avg_cyclomatic).not.toBeNull();
  });

  it('aggregated envelope contains every documented top-level key', () => {
    const result = selfAudit(store);
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('dead_exports_top10');
    expect(result).toHaveProperty('untested_top10');
    expect(result).toHaveProperty('most_imported_files');
    expect(result).toHaveProperty('most_dependent_files');
    expect(result).toHaveProperty('widest_interfaces');
    expect(result).toHaveProperty('most_complex_symbols');
    expect(result).toHaveProperty('most_unstable');
    // summary contract:
    for (const k of [
      'total_files',
      'total_symbols',
      'total_edges',
      'total_exports',
      'dead_exports',
      'untested_exports',
      'test_files',
      'import_edges',
      'heritage_edges',
      'test_covers_edges',
      'dependency_cycles',
      'unstable_modules',
      'avg_cyclomatic',
    ]) {
      expect(result.summary).toHaveProperty(k);
    }
  });
});
