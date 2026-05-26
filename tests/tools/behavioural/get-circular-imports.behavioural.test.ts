/**
 * Behavioural coverage for `getDependencyCycles()` in
 * `src/tools/analysis/graph-analysis.ts` (the implementation behind the
 * `get_circular_imports` MCP tool). Builds a file-level import graph with
 * `esm_imports` edges and asserts cycle detection via Kosaraju's SCC.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getDependencyCycles, isTestPath } from '../../../src/tools/analysis/graph-analysis.js';
import { createTestStore } from '../../test-utils.js';

interface FileNode {
  filePath: string;
  fileNodeId: number;
}

function insertFileNode(store: Store, filePath: string): FileNode {
  const fid = store.insertFile(filePath, 'typescript', `h-${filePath}`, 100);
  // Anchor symbol so the file is materialised; not strictly required by
  // buildFileGraph (it joins file-level edges directly), but mirrors how
  // real indexer output looks.
  store.insertSymbol(fid, {
    symbolId: `${filePath}::main#function`,
    name: 'main',
    kind: 'function',
    fqn: 'main',
    byteStart: 0,
    byteEnd: 20,
    lineStart: 1,
    lineEnd: 3,
  });
  return { filePath, fileNodeId: store.getNodeId('file', fid)! };
}

function importEdge(store: Store, from: FileNode, to: FileNode): void {
  store.insertEdge(
    from.fileNodeId,
    to.fileNodeId,
    'esm_imports',
    true,
    undefined,
    false,
    'ast_resolved',
  );
}

function nonImportEdge(store: Store, from: FileNode, to: FileNode, edgeType: string): void {
  store.insertEdge(
    from.fileNodeId,
    to.fileNodeId,
    edgeType,
    true,
    undefined,
    false,
    'ast_resolved',
  );
}

describe('getDependencyCycles() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('acyclic graph: A -> B -> C produces zero cycles', () => {
    const a = insertFileNode(store, 'src/a.ts');
    const b = insertFileNode(store, 'src/b.ts');
    const c = insertFileNode(store, 'src/c.ts');
    importEdge(store, a, b);
    importEdge(store, b, c);

    const cycles = getDependencyCycles(store);
    expect(cycles).toEqual([]);
  });

  it('2-cycle: A <-> B produces one cycle containing both files', () => {
    const a = insertFileNode(store, 'src/a.ts');
    const b = insertFileNode(store, 'src/b.ts');
    importEdge(store, a, b);
    importEdge(store, b, a);

    const cycles = getDependencyCycles(store);
    expect(cycles.length).toBe(1);
    expect(cycles[0].files.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(cycles[0].length).toBe(2);
  });

  it('3-cycle: A -> B -> C -> A produces one cycle of 3 files', () => {
    const a = insertFileNode(store, 'src/a.ts');
    const b = insertFileNode(store, 'src/b.ts');
    const c = insertFileNode(store, 'src/c.ts');
    importEdge(store, a, b);
    importEdge(store, b, c);
    importEdge(store, c, a);

    const cycles = getDependencyCycles(store);
    expect(cycles.length).toBe(1);
    expect(cycles[0].length).toBe(3);
    expect(cycles[0].files.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('multiple disjoint cycles surface as separate entries', () => {
    // Cycle 1: A <-> B
    const a = insertFileNode(store, 'src/a.ts');
    const b = insertFileNode(store, 'src/b.ts');
    importEdge(store, a, b);
    importEdge(store, b, a);
    // Cycle 2: X <-> Y (disjoint from cycle 1)
    const x = insertFileNode(store, 'src/x.ts');
    const y = insertFileNode(store, 'src/y.ts');
    importEdge(store, x, y);
    importEdge(store, y, x);

    const cycles = getDependencyCycles(store);
    expect(cycles.length).toBe(2);
    const totalFiles = cycles.flatMap((c) => c.files).sort();
    expect(totalFiles).toEqual(['src/a.ts', 'src/b.ts', 'src/x.ts', 'src/y.ts']);
    // Each entry must be a balanced 2-cycle.
    for (const cyc of cycles) expect(cyc.length).toBe(2);
  });

  it('cycle entries expose file paths, not raw node ids', () => {
    const a = insertFileNode(store, 'src/alpha.ts');
    const b = insertFileNode(store, 'src/beta.ts');
    importEdge(store, a, b);
    importEdge(store, b, a);

    const cycles = getDependencyCycles(store);
    expect(cycles.length).toBe(1);
    for (const f of cycles[0].files) {
      expect(typeof f).toBe('string');
      // No "[file:NNN]" placeholder leaks — real path is materialised.
      expect(f.startsWith('[file:')).toBe(false);
      // Path looks like a relative source path.
      expect(f.endsWith('.ts')).toBe(true);
    }
  });

  describe('test-file exclusion (default behaviour)', () => {
    it('test↔source bidirectional cycle is suppressed by default', () => {
      const src = insertFileNode(store, 'src/tools/analysis/visualize-aggregate.ts');
      const test = insertFileNode(store, 'tests/tools/visualize-aggregate.test.ts');
      // Real test-file import: test → source. (How a test pulls in code.)
      importEdge(store, test, src);
      // Spurious reverse edge (this is what real indexers occasionally add
      // when a project-context scan or fixture scan emits an import edge
      // back into a .test.ts file). The 2-node cycle that previously
      // surfaced from this pair must not be reported.
      importEdge(store, src, test);

      const cycles = getDependencyCycles(store);
      expect(cycles).toEqual([]);
    });

    it('giant SCC mixing src + tests collapses to the src-only sub-cycle', () => {
      // Three-node real cycle in src.
      const a = insertFileNode(store, 'src/a.ts');
      const b = insertFileNode(store, 'src/b.ts');
      const c = insertFileNode(store, 'src/c.ts');
      importEdge(store, a, b);
      importEdge(store, b, c);
      importEdge(store, c, a);

      // Bunch of test files dragged in via bogus reverse imports.
      const t1 = insertFileNode(store, 'tests/foo.test.ts');
      const t2 = insertFileNode(store, 'tests/bar.spec.ts');
      const t3 = insertFileNode(store, 'src/__tests__/baz.ts');
      importEdge(store, t1, a);
      importEdge(store, a, t1); // spurious back-edge
      importEdge(store, t2, b);
      importEdge(store, b, t2); // spurious back-edge
      importEdge(store, t3, c);
      importEdge(store, c, t3); // spurious back-edge

      const cycles = getDependencyCycles(store);
      // With include_tests=false (default) we expect exactly the real
      // 3-node src cycle.
      expect(cycles.length).toBe(1);
      expect(cycles[0].length).toBe(3);
      const files = cycles[0].files.sort();
      expect(files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
      // No test path appears anywhere in any reported cycle.
      for (const cyc of cycles) {
        for (const f of cyc.files) expect(isTestPath(f)).toBe(false);
      }
    });

    it('include_tests: true brings spurious test cycles back', () => {
      const src = insertFileNode(store, 'src/x.ts');
      const test = insertFileNode(store, 'tests/x.test.ts');
      importEdge(store, src, test);
      importEdge(store, test, src);

      const filtered = getDependencyCycles(store);
      const unfiltered = getDependencyCycles(store, { includeTests: true });
      expect(filtered).toEqual([]);
      expect(unfiltered.length).toBe(1);
      expect(unfiltered[0].files.sort()).toEqual(['src/x.ts', 'tests/x.test.ts']);
    });

    it('mixed synthetic graph: real cycle + test cycle + member_of cycle → 1 cycle', () => {
      // (1) Real 3-node import cycle a -> b -> c -> a (no tests).
      const a = insertFileNode(store, 'src/a.ts');
      const b = insertFileNode(store, 'src/b.ts');
      const c = insertFileNode(store, 'src/c.ts');
      importEdge(store, a, b);
      importEdge(store, b, c);
      importEdge(store, c, a);

      // (2) Test-only cycle: src/x.ts <-> tests/x.test.ts via imports edges.
      const x = insertFileNode(store, 'src/x.ts');
      const xt = insertFileNode(store, 'tests/x.test.ts');
      importEdge(store, x, xt);
      importEdge(store, xt, x);

      // (3) member_of-only cycle: p <-> q via non-import edges.
      const p = insertFileNode(store, 'src/p.ts');
      const q = insertFileNode(store, 'src/q.ts');
      nonImportEdge(store, p, q, 'member_of');
      nonImportEdge(store, q, p, 'member_of');

      const cycles = getDependencyCycles(store);
      expect(cycles.length).toBe(1);
      expect(cycles[0].length).toBe(3);
      expect(cycles[0].files.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    });

    it('isTestPath matches the documented patterns', () => {
      const positives = [
        'tests/foo.ts',
        'tests/sub/dir/foo.ts',
        'packages/app/tests/main.ts',
        'src/foo.test.ts',
        'src/foo.test.tsx',
        'src/foo.spec.ts',
        'src/foo.spec.js',
        'src/foo.test.mjs',
        'src/__tests__/foo.ts',
        'packages/app/test/main.ts',
      ];
      const negatives = [
        'src/foo.ts',
        'src/tools/test-utils.ts', // utility module, not a test
        'src/testing.ts',
        'src/contest.ts',
      ];
      for (const p of positives) expect(isTestPath(p), p).toBe(true);
      for (const p of negatives) expect(isTestPath(p), p).toBe(false);
    });
  });
});
