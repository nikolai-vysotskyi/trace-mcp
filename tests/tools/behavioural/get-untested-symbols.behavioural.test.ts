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

  // ─── P1-1: non-code language filter ──────────────────────────────────────
  // The markdown plugin maps `## headings` to `kind: class`, so without a
  // language-aware filter the result set is flooded with CHANGELOG entries
  // like `[1.10.0]`. The guard below pins the new default behaviour and the
  // include_non_code escape hatch.

  it('excludes non-code (markdown/json/yaml/…) symbols by default', () => {
    // One real TS function — should appear.
    const tsId = store.insertFile('src/util.ts', 'typescript', 'h1', 100);
    store.insertSymbol(tsId, {
      symbolId: 'src/util.ts::doWork#function',
      name: 'doWork',
      kind: 'function',
      byteStart: 0,
      byteEnd: 40,
    });

    // Mimic markdown plugin output: heading registered as kind=class, file
    // language=markdown. Use a CHANGELOG-style name to exercise the actual
    // regression we are guarding against.
    const mdId = store.insertFile('CHANGELOG.md', 'markdown', 'h2', 100);
    store.insertSymbol(mdId, {
      symbolId: 'CHANGELOG.md::CHANGELOG#[1.10.0]#class',
      name: '[1.10.0]',
      kind: 'class',
      byteStart: 0,
      byteEnd: 40,
    });
    // Also a YAML entry — should be filtered too.
    const ymlId = store.insertFile('config.yaml', 'yaml', 'h3', 100);
    store.insertSymbol(ymlId, {
      symbolId: 'config.yaml::root#class',
      name: 'root',
      kind: 'class',
      byteStart: 0,
      byteEnd: 40,
    });
    // JSON declaration symbol.
    const jsonId = store.insertFile('package.json', 'json', 'h4', 100);
    store.insertSymbol(jsonId, {
      symbolId: 'package.json::pkg#class',
      name: 'pkg',
      kind: 'class',
      byteStart: 0,
      byteEnd: 40,
    });

    const result = getUntestedSymbols(store);
    const names = result.untested.map((u) => u.name);
    expect(names).toContain('doWork');
    expect(names).not.toContain('[1.10.0]');
    expect(names).not.toContain('root');
    expect(names).not.toContain('pkg');

    // total_symbols counts the candidate universe — markdown/yaml/json
    // entries must be excluded there too (not just from the output list).
    expect(result.total_symbols).toBe(1);
  });

  it('include_non_code=true restores legacy behaviour (markdown headings included)', () => {
    const tsId = store.insertFile('src/util.ts', 'typescript', 'h1', 100);
    store.insertSymbol(tsId, {
      symbolId: 'src/util.ts::doWork#function',
      name: 'doWork',
      kind: 'function',
      byteStart: 0,
      byteEnd: 40,
    });
    const mdId = store.insertFile('CHANGELOG.md', 'markdown', 'h2', 100);
    store.insertSymbol(mdId, {
      symbolId: 'CHANGELOG.md::CHANGELOG#[1.10.0]#class',
      name: '[1.10.0]',
      kind: 'class',
      byteStart: 0,
      byteEnd: 40,
    });

    const result = getUntestedSymbols(store, undefined, undefined, true);
    const names = result.untested.map((u) => u.name);
    expect(names).toContain('doWork');
    expect(names).toContain('[1.10.0]');
  });

  it('classification (unreached vs imported_not_called) still works after filter', () => {
    // unreached TS symbol
    const orphanId = store.insertFile('src/orphan.ts', 'typescript', 'h1', 100);
    store.insertSymbol(orphanId, {
      symbolId: 'src/orphan.ts::orphanFn#function',
      name: 'orphanFn',
      kind: 'function',
      byteStart: 0,
      byteEnd: 40,
    });

    // covered (imports edge present) but symbol never referenced
    const srcFileId = store.insertFile('src/covered.ts', 'typescript', 'h2', 100);
    const symId = store.insertSymbol(srcFileId, {
      symbolId: 'src/covered.ts::neverCalled#function',
      name: 'neverCalled',
      kind: 'function',
      byteStart: 0,
      byteEnd: 40,
    });
    const testFileId = store.insertFile('tests/covered.test.ts', 'typescript', 'h3', 100);
    store.insertSymbol(testFileId, {
      symbolId: 'tests/covered.test.ts::otherTest#function',
      name: 'otherTest',
      kind: 'function',
      byteStart: 0,
      byteEnd: 30,
    });
    const testFileNid = store.getNodeId('file', testFileId)!;
    const srcSymNid = store.getNodeId('symbol', symId)!;
    const srcFileNid = store.getNodeId('file', srcFileId)!;
    store.insertEdge(testFileNid, srcSymNid, 'test_covers', true, undefined, false, 'ast_resolved');
    store.insertEdge(testFileNid, srcFileNid, 'imports', true, undefined, false, 'ast_resolved');

    // Markdown noise that would otherwise mask the real signal.
    const mdId = store.insertFile('CHANGELOG.md', 'markdown', 'h4', 100);
    store.insertSymbol(mdId, {
      symbolId: 'CHANGELOG.md::CHANGELOG#[1.10.0]#class',
      name: '[1.10.0]',
      kind: 'class',
      byteStart: 0,
      byteEnd: 40,
    });

    const result = getUntestedSymbols(store);
    const orphan = result.untested.find((u) => u.name === 'orphanFn');
    const covered = result.untested.find((u) => u.name === 'neverCalled');
    expect(orphan?.level).toBe('unreached');
    expect(covered?.level).toBe('imported_not_called');
    // Sanity: both classifications counted, no markdown leakage.
    expect(result.by_level.unreached).toBeGreaterThanOrEqual(1);
    expect(result.by_level.imported_not_called).toBeGreaterThanOrEqual(1);
    expect(result.untested.some((u) => u.name === '[1.10.0]')).toBe(false);
  });
});
