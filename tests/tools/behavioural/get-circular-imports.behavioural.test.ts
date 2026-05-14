/**
 * Behavioural coverage for `getDependencyCycles()` in
 * `src/tools/analysis/graph-analysis.ts` (the implementation behind the
 * `get_circular_imports` MCP tool). Builds a file-level import graph with
 * `esm_imports` edges and asserts cycle detection via Kosaraju's SCC.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getDependencyCycles } from '../../../src/tools/analysis/graph-analysis.js';
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
});
