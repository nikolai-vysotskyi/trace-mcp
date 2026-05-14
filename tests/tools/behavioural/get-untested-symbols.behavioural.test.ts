/**
 * Behavioural coverage for the `get_untested_symbols` MCP tool
 * (`getUntestedSymbols()`), which classifies untested symbols into two
 * tiers: "unreached" (no test file reaches the source) and
 * "imported_not_called" (test file imports the source file but never
 * references this specific symbol).
 *
 * The existing tests/tools/introspect.test.ts asserts the high-level
 * envelope (level field, by_level totals, max_results, sort order). This
 * file complements it by asserting:
 *
 *  - A source symbol with no test importer is classified 'unreached'.
 *  - A source symbol whose file *is* imported by a test file via test_covers
 *    but which the test file never references by name is classified
 *    'imported_not_called'.
 *  - file_pattern narrows scope to matching files only.
 *  - max_results respects the cap while preserving total_untested.
 *  - Each item carries symbol_id / name / kind / file / level.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getUntestedSymbols } from '../../../src/tools/analysis/introspect.js';
import { createTestStore } from '../../test-utils.js';

describe('get_untested_symbols — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('symbol in a source file with no test importer is classified "unreached"', () => {
    const fileId = store.insertFile('src/orphan.ts', 'typescript', 'h1', 100);
    store.insertSymbol(fileId, {
      symbolId: 'src/orphan.ts::orphanFn#function',
      name: 'orphanFn',
      kind: 'function',
      byteStart: 0,
      byteEnd: 40,
    });

    const result = getUntestedSymbols(store);
    const item = result.untested.find((u) => u.name === 'orphanFn');
    expect(item).toBeDefined();
    expect(item!.level).toBe('unreached');
    expect(item!.file).toBe('src/orphan.ts');
    expect(item!.kind).toBe('function');
  });

  it('symbol whose file is imported by a test but never referenced → "imported_not_called"', () => {
    // Source file with a function that the test never invokes.
    const srcFileId = store.insertFile('src/covered.ts', 'typescript', 'h1', 100);
    const symId = store.insertSymbol(srcFileId, {
      symbolId: 'src/covered.ts::neverCalled#function',
      name: 'neverCalled',
      kind: 'function',
      byteStart: 0,
      byteEnd: 40,
    });
    // Test file with a single test symbol whose name does NOT contain
    // "neverCalled" — exercises the imported_not_called classification.
    const testFileId = store.insertFile('tests/covered.test.ts', 'typescript', 'h2', 100);
    store.insertSymbol(testFileId, {
      symbolId: 'tests/covered.test.ts::otherTest#function',
      name: 'otherTest',
      kind: 'function',
      byteStart: 0,
      byteEnd: 30,
    });

    // Wire a test_covers edge from the test file to the source symbol so
    // the file is recorded as "reached".
    const testFileNid = store.getNodeId('file', testFileId)!;
    const srcSymNid = store.getNodeId('symbol', symId)!;
    const srcFileNid = store.getNodeId('file', srcFileId)!;
    store.insertEdge(testFileNid, srcSymNid, 'test_covers', true, undefined, false, 'ast_resolved');
    // Imports edge → wires test file's outgoing imports so the
    // testFileSymbolNames map for "covered" gets populated.
    store.insertEdge(testFileNid, srcFileNid, 'imports', true, undefined, false, 'ast_resolved');

    const result = getUntestedSymbols(store);
    const item = result.untested.find((u) => u.name === 'neverCalled');
    expect(item).toBeDefined();
    expect(item!.level).toBe('imported_not_called');
  });

  it('file_pattern narrows scope to matching files only', () => {
    const aId = store.insertFile('src/lib/widget.ts', 'typescript', 'h1', 100);
    const bId = store.insertFile('src/util/helper.ts', 'typescript', 'h2', 100);
    store.insertSymbol(aId, {
      symbolId: 'src/lib/widget.ts::widgetFn#function',
      name: 'widgetFn',
      kind: 'function',
      byteStart: 0,
      byteEnd: 40,
    });
    store.insertSymbol(bId, {
      symbolId: 'src/util/helper.ts::helperFn#function',
      name: 'helperFn',
      kind: 'function',
      byteStart: 0,
      byteEnd: 40,
    });

    const result = getUntestedSymbols(store, 'src/lib/%');
    expect(result.file_pattern).toBe('src/lib/%');
    for (const item of result.untested) {
      expect(item.file.startsWith('src/lib/')).toBe(true);
    }
    expect(result.untested.some((u) => u.name === 'widgetFn')).toBe(true);
    expect(result.untested.some((u) => u.name === 'helperFn')).toBe(false);
  });

  it('max_results caps the returned list but preserves total_untested', () => {
    for (let i = 0; i < 5; i++) {
      const fid = store.insertFile(`src/orphan${i}.ts`, 'typescript', `h${i}`, 100);
      store.insertSymbol(fid, {
        symbolId: `src/orphan${i}.ts::fn${i}#function`,
        name: `fn${i}`,
        kind: 'function',
        byteStart: 0,
        byteEnd: 40,
      });
    }

    const full = getUntestedSymbols(store);
    expect(full.total_untested).toBeGreaterThanOrEqual(5);
    const limited = getUntestedSymbols(store, undefined, 2);
    expect(limited.untested.length).toBeLessThanOrEqual(2);
    // Total stays accurate even when the array is truncated.
    expect(limited.total_untested).toBe(full.total_untested);
  });

  it('result envelope: each item has symbol_id / name / kind / file / level', () => {
    const fileId = store.insertFile('src/sample.ts', 'typescript', 'h1', 100);
    store.insertSymbol(fileId, {
      symbolId: 'src/sample.ts::sample#function',
      name: 'sample',
      kind: 'function',
      byteStart: 0,
      byteEnd: 40,
    });

    const result = getUntestedSymbols(store);
    expect(Array.isArray(result.untested)).toBe(true);
    expect(typeof result.total_symbols).toBe('number');
    expect(typeof result.total_untested).toBe('number');
    expect(typeof result.by_level.unreached).toBe('number');
    expect(typeof result.by_level.imported_not_called).toBe('number');
    for (const item of result.untested) {
      expect(typeof item.symbol_id).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.kind).toBe('string');
      expect(typeof item.file).toBe('string');
      expect(['unreached', 'imported_not_called']).toContain(item.level);
    }
  });
});
