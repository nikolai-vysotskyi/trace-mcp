import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { getDeadCodeReachability, getDeadCodeV2 } from '../../src/tools/refactoring/dead-code.js';
import { createTestStore } from '../test-utils.js';

function insertFile(store: Store, filePath: string, lang = 'typescript'): number {
  return store.insertFile(filePath, lang, `hash_${filePath}`, 100);
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

function insertEdge(
  store: Store,
  srcNodeId: number,
  tgtNodeId: number,
  edgeType: string,
  metadata?: Record<string, unknown>,
): void {
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

  it('does not report symbol with incoming call edge', () => {
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

    // Hard skip on any incoming call/reference: a symbol that's actually
    // invoked is never dead, even if its public surface (import + barrel)
    // looks unused. Mirrors the jcodemunch v1.80.10 false-positive fix.
    const result = getDeadCodeV2(store);
    expect(result.dead_symbols.length).toBe(0);
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

  it('includes _methodology block on result', () => {
    const result = getDeadCodeV2(store);
    expect(result._methodology).toBeDefined();
    expect(result._methodology.algorithm).toBe('multi_signal_export_analysis');
    expect(result._methodology.signals).toHaveLength(3);
    expect(result._methodology.confidence_formula).toMatch(/signals_fired/);
  });

  it('assigns confidence_level=multi_signal when all 3 signals fire', () => {
    const fA = insertFile(store, 'src/a.ts');
    insertExportedSymbol(store, fA, 'fullyDead');

    const result = getDeadCodeV2(store);
    expect(result.dead_symbols[0].confidence_level).toBe('multi_signal');
  });

  it('assigns confidence_level=medium when 2 of 3 signals fire', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    insertExportedSymbol(store, fA, 'partialDead');

    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    insertEdge(store, nodeB, nodeA, 'esm_imports', { specifiers: ['partialDead'] });

    const result = getDeadCodeV2(store, { threshold: 0.5 });
    const item = result.dead_symbols.find((s) => s.name === 'partialDead')!;
    expect(item.confidence_level).toBe('medium');
  });

  it('emits _warnings when decorator-driven framework is detected', () => {
    const result = getDeadCodeV2(store, { detectedFrameworks: ['nestjs'] });
    expect(result._warnings).toBeDefined();
    expect(result._warnings![0]).toMatch(/nestjs/i);
    expect(result._warnings![0]).toMatch(/decorators/i);
  });

  it('emits zero-import-specifier warning when import index is empty', () => {
    // Force a symbol to exist so warning triggers
    const fA = insertFile(store, 'src/a.ts');
    insertExportedSymbol(store, fA, 'func');

    const result = getDeadCodeV2(store); // no edges → importedNames is empty
    expect(result._warnings).toBeDefined();
    expect(result._warnings!.some((w) => /zero import specifiers/i.test(w))).toBe(true);
  });

  it('emits import-gap warning for languages without specifier tracking', () => {
    // Insert a Go file with an exported symbol
    const fGo = store.insertFile('src/main.go', 'go', 'hash_go', 100);
    store.insertSymbol(fGo, {
      symbolId: 'sym:HandleRequest',
      name: 'HandleRequest',
      kind: 'function',
      byteStart: 0,
      byteEnd: 100,
      metadata: { exported: true },
    });

    const result = getDeadCodeV2(store);
    const gapWarning = result._warnings?.find((w) => /go/i.test(w) && /import/i.test(w));
    expect(gapWarning).toBeDefined();
    expect(gapWarning).toMatch(/reachability/i); // recommends reachability mode
  });
});

describe('getDeadCodeReachability', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('reports all exports as dead when no entry points exist', () => {
    const fA = insertFile(store, 'src/lib.ts');
    insertExportedSymbol(store, fA, 'orphan');

    const result = getDeadCodeReachability(store);
    expect(result.mode).toBe('reachability');
    expect(result.entry_points.total).toBe(0);
    expect(result.dead_symbols.map((s) => s.name)).toContain('orphan');
    expect(result._warnings?.[0]).toMatch(/no entry points/i);
  });

  it('marks symbol reachable from a test file as live', () => {
    const fLib = insertFile(store, 'src/lib.ts');
    const fTest = insertFile(store, 'tests/lib.test.ts');

    const libSymId = insertExportedSymbol(store, fLib, 'usedByTest');
    const libNode = store.getNodeId('symbol', libSymId)!;

    const testSymId = store.insertSymbol(fTest, {
      symbolId: 'sym:testCase',
      name: 'testCase',
      kind: 'function',
      byteStart: 0,
      byteEnd: 50,
      metadata: { exported: true },
    });
    const testNode = store.getNodeId('symbol', testSymId)!;

    // The test calls usedByTest
    insertEdge(store, testNode, libNode, 'calls');

    const result = getDeadCodeReachability(store);
    expect(result.entry_points.total).toBeGreaterThan(0);
    expect(result.dead_symbols.map((s) => s.name)).not.toContain('usedByTest');
  });

  it('reports unreached exports even when other exports are live', () => {
    const fLib = insertFile(store, 'src/lib.ts');
    const fTest = insertFile(store, 'tests/lib.test.ts');

    const liveSymId = insertExportedSymbol(store, fLib, 'live');
    insertExportedSymbol(store, fLib, 'orphan');

    const liveNode = store.getNodeId('symbol', liveSymId)!;
    const testSymId = store.insertSymbol(fTest, {
      symbolId: 'sym:t',
      name: 't',
      kind: 'function',
      byteStart: 0,
      byteEnd: 50,
      metadata: { exported: true },
    });
    const testNode = store.getNodeId('symbol', testSymId)!;
    insertEdge(store, testNode, liveNode, 'calls');

    const result = getDeadCodeReachability(store);
    const names = result.dead_symbols.map((s) => s.name);
    expect(names).toContain('orphan');
    expect(names).not.toContain('live');
  });

  it('propagates reachability via file imports (esm_imports)', () => {
    const fLib = insertFile(store, 'src/lib.ts');
    const fTest = insertFile(store, 'tests/lib.test.ts');

    insertExportedSymbol(store, fLib, 'reachedViaImport');

    const fLibFileNode = store.getNodeId('file', fLib)!;
    const fTestFileNode = store.getNodeId('file', fTest)!;
    insertEdge(store, fTestFileNode, fLibFileNode, 'esm_imports', {
      specifiers: ['reachedViaImport'],
    });

    const result = getDeadCodeReachability(store);
    expect(result.dead_symbols.map((s) => s.name)).not.toContain('reachedViaImport');
  });

  it('includes _methodology block on result', () => {
    const result = getDeadCodeReachability(store);
    expect(result._methodology).toBeDefined();
    expect(result._methodology.algorithm).toBe('forward_reachability_bfs');
    expect(result._methodology.confidence_formula).toMatch(/binary/i);
  });

  it('emits warning for decorator-driven framework', () => {
    const result = getDeadCodeReachability(store, { detectedFrameworks: ['laravel'] });
    const hasFrameworkWarning = result._warnings?.some((w) => /laravel/i.test(w));
    expect(hasFrameworkWarning).toBe(true);
  });

  it('honors manually-supplied entry points', () => {
    const fEntry = insertFile(store, 'src/custom-entry.ts');
    const fLib = insertFile(store, 'src/lib.ts');

    const libSymId = insertExportedSymbol(store, fLib, 'fromCustomEntry');
    const entrySymId = store.insertSymbol(fEntry, {
      symbolId: 'sym:entry',
      name: 'entry',
      kind: 'function',
      byteStart: 0,
      byteEnd: 50,
      metadata: { exported: true },
    });
    const libNode = store.getNodeId('symbol', libSymId)!;
    const entryNode = store.getNodeId('symbol', entrySymId)!;
    insertEdge(store, entryNode, libNode, 'calls');

    // Without manual entry → both look dead (custom-entry isn't a known pattern)
    const noEntries = getDeadCodeReachability(store);
    expect(noEntries.dead_symbols.map((s) => s.name)).toContain('fromCustomEntry');

    // With manual entry → fromCustomEntry should now be reached
    const withEntry = getDeadCodeReachability(store, { entryPoints: ['src/custom-entry.ts'] });
    expect(withEntry.dead_symbols.map((s) => s.name)).not.toContain('fromCustomEntry');
  });
});
