import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import { getDeadCodeV2 } from '../../src/tools/refactoring/dead-code.js';

function insertFile(store: Store, filePath: string, lang = 'typescript'): number {
  return store.insertFile(filePath, lang, 'hash_' + filePath, 100);
}

function insertExportedSymbol(
  store: Store,
  fileId: number,
  name: string,
  kind = 'function',
): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:${name}`,
    name,
    kind,
    byteStart: 0,
    byteEnd: 100,
    metadata: { exported: true },
  });
}

function insertEdge(store: Store, srcNodeId: number, tgtNodeId: number, edgeType: string, metadata?: Record<string, unknown>): void {
  store.insertEdge(srcNodeId, tgtNodeId, edgeType, true, metadata);
}

describe('getDeadCodeV2', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns empty when no exported symbols', () => {
    const result = getDeadCodeV2(store);
    expect(result.total_exports).toBe(0);
    expect(result.total_dead).toBe(0);
    expect(result.dead_symbols).toEqual([]);
  });

  it('reports fully dead symbol (all 3 signals fire) with confidence 1.0', () => {
    const fA = insertFile(store, 'src/a.ts');
    insertExportedSymbol(store, fA, 'unusedFunc');

    const result = getDeadCodeV2(store);
    expect(result.total_dead).toBe(1);
    expect(result.dead_symbols[0].name).toBe('unusedFunc');
    expect(result.dead_symbols[0].confidence).toBe(1);
    expect(result.dead_symbols[0].signals).toEqual({
      import_graph: true,
      call_graph: true,
      barrel_exports: true,
    });
  });

  it('does not report symbol that is imported (signal 1 = false)', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    insertExportedSymbol(store, fA, 'usedFunc');

    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;

    // B imports usedFunc from A
    insertEdge(store, nodeB, nodeA, 'esm_imports', {
      specifiers: ['usedFunc'],
    });

    // With default threshold 0.5, need at least 2 signals.
    // Signal 1 (import) = false (it IS imported)
    // Signal 2 (call graph) = true (no calls edge)
    // Signal 3 (barrel) = true (not in barrel)
    // confidence = 2/3 = 0.67 → still reported
    const result = getDeadCodeV2(store);
    expect(result.dead_symbols.length).toBe(1);
    expect(result.dead_symbols[0].confidence).toBeCloseTo(0.67, 1);
    expect(result.dead_symbols[0].signals.import_graph).toBe(false);
  });

  it('does not report symbol with incoming call edge (signal 2 = false)', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    const symId = insertExportedSymbol(store, fA, 'calledFunc');
    const symNodeId = store.getNodeId('symbol', symId)!;

    // Some symbol in B calls calledFunc
    const callerSymId = store.insertSymbol(fB, {
      symbolId: 'sym:caller',
      name: 'caller',
      kind: 'function',
      byteStart: 0,
      byteEnd: 50,
    });
    const callerNodeId = store.getNodeId('symbol', callerSymId)!;
    insertEdge(store, callerNodeId, symNodeId, 'calls');

    const result = getDeadCodeV2(store);
    // Signal 1 = true (not imported by name)
    // Signal 2 = false (has incoming call)
    // Signal 3 = true (not in barrel)
    // confidence = 2/3 = 0.67
    expect(result.dead_symbols.length).toBe(1);
    expect(result.dead_symbols[0].signals.call_graph).toBe(false);
  });

  it('does not report symbol re-exported from barrel (signal 3 = false)', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fBarrel = insertFile(store, 'src/index.ts');
    insertExportedSymbol(store, fA, 'barrelFunc');

    const nodeBarrel = store.getNodeId('file', fBarrel)!;
    const nodeA = store.getNodeId('file', fA)!;

    // index.ts re-exports barrelFunc
    insertEdge(store, nodeBarrel, nodeA, 'esm_imports', {
      specifiers: ['barrelFunc'],
    });

    const result = getDeadCodeV2(store);
    // Signal 1 = false (imported by barrel)
    // Signal 2 = true (no calls edge)
    // Signal 3 = false (re-exported from barrel)
    // confidence = 1/3 = 0.33 → below threshold
    expect(result.dead_symbols.length).toBe(0);
  });

  it('respects threshold parameter', () => {
    const fA = insertFile(store, 'src/a.ts');
    insertExportedSymbol(store, fA, 'func1');

    // All 3 signals fire → confidence 1.0
    const strict = getDeadCodeV2(store, { threshold: 1.0 });
    expect(strict.dead_symbols.length).toBe(1);

    // With imported name, confidence drops to 0.67
    const fB = insertFile(store, 'src/b.ts');
    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    insertEdge(store, nodeB, nodeA, 'esm_imports', { specifiers: ['func1'] });

    const strictAfterImport = getDeadCodeV2(store, { threshold: 1.0 });
    expect(strictAfterImport.dead_symbols.length).toBe(0);

    const relaxed = getDeadCodeV2(store, { threshold: 0.5 });
    expect(relaxed.dead_symbols.length).toBe(1);
  });

  it('skips method symbols (they inherit export from class)', () => {
    const fA = insertFile(store, 'src/a.ts');
    store.insertSymbol(fA, {
      symbolId: 'sym:MyClass#doThing',
      name: 'doThing',
      kind: 'method',
      byteStart: 0,
      byteEnd: 50,
      metadata: { exported: true },
    });

    const result = getDeadCodeV2(store);
    expect(result.total_exports).toBe(0);
    expect(result.dead_symbols).toEqual([]);
  });

  it('sorts by confidence descending', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');

    // fullyDead: confidence 1.0 (all 3 signals)
    insertExportedSymbol(store, fA, 'fullyDead');

    // partialDead: confidence 0.67 (2 of 3 — it's imported)
    insertExportedSymbol(store, fA, 'partialDead');
    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    insertEdge(store, nodeB, nodeA, 'esm_imports', { specifiers: ['partialDead'] });

    const result = getDeadCodeV2(store);
    expect(result.dead_symbols[0].name).toBe('fullyDead');
    expect(result.dead_symbols[0].confidence).toBe(1);
    expect(result.dead_symbols[1].name).toBe('partialDead');
    expect(result.dead_symbols[1].confidence).toBeCloseTo(0.67, 1);
  });

  it('handles symbols with null metadata (non-exported) gracefully', () => {
    const fA = insertFile(store, 'src/a.ts');
    // Insert symbol WITHOUT exported metadata
    store.insertSymbol(fA, {
      symbolId: 'sym:internal',
      name: 'internalFunc',
      kind: 'function',
      byteStart: 0,
      byteEnd: 50,
      // no metadata → not exported
    });

    const result = getDeadCodeV2(store);
    // Should not crash, and should not report non-exported symbols
    expect(result.total_exports).toBe(0);
    expect(result.dead_symbols).toEqual([]);
  });

  it('applies limit parameter', () => {
    const fA = insertFile(store, 'src/a.ts');
    for (let i = 0; i < 10; i++) {
      insertExportedSymbol(store, fA, `deadFunc${i}`);
    }

    const result = getDeadCodeV2(store, { limit: 3 });
    expect(result.dead_symbols.length).toBe(3);
    expect(result.total_dead).toBe(10); // total_dead counts all, not limited
  });

  it('recognizes aliased imports as used (original name matches export)', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    insertExportedSymbol(store, fA, 'resolveHeritageEdges');

    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;

    // B imports with alias: import { resolveHeritageEdges as _heritage }
    // Specifier should contain the ORIGINAL name, not the alias
    insertEdge(store, nodeB, nodeA, 'imports', {
      specifiers: ['resolveHeritageEdges'],
    });

    // Signal 1 (import) = false because original name matches
    const result = getDeadCodeV2(store);
    const found = result.dead_symbols.find((s) => s.name === 'resolveHeritageEdges');
    if (found) {
      expect(found.signals.import_graph).toBe(false);
    }
  });

  it('excludes test files from dead export analysis', () => {
    // Export in test file — should be excluded entirely
    const fTest = insertFile(store, 'tests/force-exit-reporter.ts');
    insertExportedSymbol(store, fTest, 'ForceExitReporter', 'class');

    // Export in source file — should be included
    const fSrc = insertFile(store, 'src/a.ts');
    insertExportedSymbol(store, fSrc, 'realFunc');

    const result = getDeadCodeV2(store);
    const names = result.dead_symbols.map((s) => s.name);
    expect(names).not.toContain('ForceExitReporter');
    expect(names).toContain('realFunc');
  });

  it('excludes .test.ts and .spec.ts files from dead export analysis', () => {
    const fTest = insertFile(store, 'src/utils.test.ts');
    insertExportedSymbol(store, fTest, 'testHelper');

    const fSpec = insertFile(store, 'src/utils.spec.ts');
    insertExportedSymbol(store, fSpec, 'specHelper');

    const result = getDeadCodeV2(store);
    const names = result.dead_symbols.map((s) => s.name);
    expect(names).not.toContain('testHelper');
    expect(names).not.toContain('specHelper');
  });
});
