import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { getDeadExports } from '../../src/tools/analysis/introspect.js';
import { createTestStore } from '../test-utils.js';

function addExportedSymbol(
  store: Store,
  filePath: string,
  name: string,
  kind: string,
  extraMetadata?: Record<string, unknown>,
): number {
  const file = store.getFile(filePath);
  const fileId = file ? file.id : store.insertFile(filePath, 'typescript', null, null);
  return store.insertSymbol(fileId, {
    symbolId: `${filePath}::${name}#${kind}`,
    name,
    kind: kind as any,
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 10,
    metadata: { exported: 1, ...extraMetadata },
  });
}

function addImportEdge(store: Store, fromFile: string, toFile: string, specifiers: string[]): void {
  const srcFile = store.getFile(fromFile);
  const srcFileId = srcFile ? srcFile.id : store.insertFile(fromFile, 'typescript', null, null);
  const tgtFile = store.getFile(toFile);
  const tgtFileId = tgtFile ? tgtFile.id : store.insertFile(toFile, 'typescript', null, null);

  const srcNodeId = store.getNodeId('file', srcFileId) ?? store.createNode('file', srcFileId);
  const tgtNodeId = store.getNodeId('file', tgtFileId) ?? store.createNode('file', tgtFileId);

  store.ensureEdgeType('imports', 'code', 'Import statements');
  store.insertEdge(srcNodeId, tgtNodeId, 'imports', true, { specifiers });
}

describe('getDeadExports', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    store.ensureEdgeType('imports', 'code', 'Import statements');
  });

  it('returns no dead exports when all are imported', () => {
    addExportedSymbol(store, 'src/utils.ts', 'helper', 'function');
    addImportEdge(store, 'src/app.ts', 'src/utils.ts', ['helper']);

    const result = getDeadExports(store);
    expect(result.dead_exports).toHaveLength(0);
    expect(result.total_exports).toBe(1);
  });

  it('finds exports that are never imported', () => {
    addExportedSymbol(store, 'src/utils.ts', 'usedFn', 'function');
    addExportedSymbol(store, 'src/utils.ts', 'unusedFn', 'function');
    addImportEdge(store, 'src/app.ts', 'src/utils.ts', ['usedFn']);

    const result = getDeadExports(store);
    expect(result.dead_exports).toHaveLength(1);
    expect(result.dead_exports[0].name).toBe('unusedFn');
    expect(result.total_dead).toBe(1);
  });

  it('excludes methods from dead export count', () => {
    addExportedSymbol(store, 'src/svc.ts', 'MyService', 'class');
    addExportedSymbol(store, 'src/svc.ts', 'doWork', 'method');
    addImportEdge(store, 'src/app.ts', 'src/svc.ts', ['MyService']);

    const result = getDeadExports(store);
    // MyService is imported, doWork is a method (excluded)
    expect(result.dead_exports).toHaveLength(0);
  });

  it('respects file pattern filtering', () => {
    addExportedSymbol(store, 'src/tools/a.ts', 'toolA', 'function');
    addExportedSymbol(store, 'src/lib/b.ts', 'libB', 'function');

    const result = getDeadExports(store, 'src/tools/*');
    expect(result.dead_exports).toHaveLength(1);
    expect(result.dead_exports[0].name).toBe('toolA');
    expect(result.file_pattern).toBe('src/tools/*');
  });

  it('handles wildcard import (* as name)', () => {
    addExportedSymbol(store, 'src/math.ts', 'add', 'function');
    addImportEdge(store, 'src/app.ts', 'src/math.ts', ['* as math']);

    const result = getDeadExports(store);
    // 'math' is added to importedNames, but 'add' is not → dead
    expect(result.dead_exports).toHaveLength(1);
    expect(result.dead_exports[0].name).toBe('add');
  });

  it('excludes symbols marked as entry points (is_entry_point metadata)', () => {
    // Simulate a Python script with if __name__ == "__main__": main()
    addExportedSymbol(store, 'scripts/check_ast.py', 'main', 'function', {
      is_entry_point: 'name_main',
    });
    addExportedSymbol(store, 'scripts/check_ast.py', 'helper', 'function');

    const result = getDeadExports(store);
    // main() should be excluded (entry point), helper() should be reported
    expect(result.dead_exports).toHaveLength(1);
    expect(result.dead_exports[0].name).toBe('helper');
  });

  it('counts entry-point symbols in total_exports but not in dead', () => {
    addExportedSymbol(store, 'scripts/run.py', 'main', 'function', {
      is_entry_point: 'name_main',
    });

    const result = getDeadExports(store);
    expect(result.total_exports).toBe(1);
    expect(result.total_dead).toBe(0);
    expect(result.dead_exports).toHaveLength(0);
  });

  // ── P2-2: pagination ──────────────────────────────────────────────────────

  it('respects the `limit` parameter and reports truncation (P2-2)', () => {
    for (let i = 0; i < 50; i++) {
      addExportedSymbol(store, `src/mod${i}.ts`, `unused${i}`, 'function');
    }

    const limited = getDeadExports(store, undefined, 10);
    expect(limited.dead_exports).toHaveLength(10);
    expect(limited.total_dead).toBe(50);
    expect(limited.truncated).toBe(true);
  });

  it('omits `truncated` field when limit not exceeded', () => {
    addExportedSymbol(store, 'src/a.ts', 'unusedA', 'function');
    addExportedSymbol(store, 'src/b.ts', 'unusedB', 'function');

    const result = getDeadExports(store, undefined, 100);
    expect(result.dead_exports).toHaveLength(2);
    expect(result.total_dead).toBe(2);
    expect(result.truncated).toBeUndefined();
  });

  it('returns full list when limit is undefined (back-compat)', () => {
    for (let i = 0; i < 5; i++) {
      addExportedSymbol(store, `src/m${i}.ts`, `unused${i}`, 'function');
    }
    const result = getDeadExports(store);
    expect(result.dead_exports).toHaveLength(5);
    expect(result.truncated).toBeUndefined();
  });

  // ── signals + recommendation (dead-export vs dead-symbol) ────────────────

  it('defaults recommendation to "delete_symbol" when projectRoot is absent', () => {
    addExportedSymbol(store, 'src/utils.ts', 'orphan', 'function');
    const result = getDeadExports(store);
    expect(result.dead_exports).toHaveLength(1);
    const [item] = result.dead_exports;
    expect(item.recommendation).toBe('delete_symbol');
    expect(item.signals).toEqual(['not_imported']);
  });
});

describe('getDeadExports — intra-file signal', () => {
  const TEST_DIR = path.join(tmpdir(), `trace-mcp-dead-exports-intra-${process.pid}`);
  let store: Store;

  function writeFixture(relPath: string, content: string): string {
    const abs = path.join(TEST_DIR, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    return relPath;
  }

  function addExportedSymbolWithRange(
    storeArg: Store,
    filePath: string,
    name: string,
    kind: string,
    lineStart: number,
    lineEnd: number,
  ): number {
    const file = storeArg.getFile(filePath);
    const fileId = file ? file.id : storeArg.insertFile(filePath, 'typescript', null, null);
    return storeArg.insertSymbol(fileId, {
      symbolId: `${filePath}::${name}#${kind}`,
      name,
      kind: kind as any,
      byteStart: 0,
      byteEnd: 100,
      lineStart,
      lineEnd,
      metadata: { exported: 1 },
    });
  }

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createTestStore();
    store.ensureEdgeType('imports', 'code', 'Import statements');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('recommends "remove_export_keyword" when the symbol is used only in its own file', () => {
    // export const CANARY = 'x';
    // export function go(arg = CANARY) {  // <-- intra-file use of CANARY
    //   return arg;
    // }
    const rel = writeFixture(
      'src/canary.ts',
      [
        "export const CANARY = 'x';",
        '',
        'export function go(arg = CANARY) {',
        '  return arg;',
        '}',
        '',
      ].join('\n'),
    );

    addExportedSymbolWithRange(store, rel, 'CANARY', 'variable', 1, 1);
    addExportedSymbolWithRange(store, rel, 'go', 'function', 3, 5);

    const result = getDeadExports(store, undefined, undefined, TEST_DIR);

    // Both exports are uncited from outside the file, so both show up.
    expect(result.dead_exports).toHaveLength(2);

    const canary = result.dead_exports.find((d) => d.name === 'CANARY');
    expect(canary).toBeDefined();
    expect(canary?.recommendation).toBe('remove_export_keyword');
    expect(canary?.signals).toEqual(expect.arrayContaining(['not_imported', 'intra_file_usage']));

    const go = result.dead_exports.find((d) => d.name === 'go');
    expect(go).toBeDefined();
    // `go` only appears in its own declaration range — no intra-file usage.
    expect(go?.recommendation).toBe('delete_symbol');
    expect(go?.signals).toEqual(['not_imported']);
  });

  it('recommends "delete_symbol" when the symbol is not referenced anywhere', () => {
    const rel = writeFixture(
      'src/orphan.ts',
      ['export function orphan() {', '  return 42;', '}', ''].join('\n'),
    );

    addExportedSymbolWithRange(store, rel, 'orphan', 'function', 1, 3);

    const result = getDeadExports(store, undefined, undefined, TEST_DIR);
    expect(result.dead_exports).toHaveLength(1);
    expect(result.dead_exports[0].recommendation).toBe('delete_symbol');
    expect(result.dead_exports[0].signals).toEqual(['not_imported']);
  });

  it('ignores docblock mentions when deciding intra-file usage', () => {
    // The docblock mentions `Helper` by name, but the only use is in the
    // declaration itself — should still be flagged for deletion.
    const rel = writeFixture(
      'src/docblock.ts',
      [
        '/**',
        ' * Helper does nothing.',
        ' */',
        'export function Helper() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    );

    addExportedSymbolWithRange(store, rel, 'Helper', 'function', 4, 6);

    const result = getDeadExports(store, undefined, undefined, TEST_DIR);
    expect(result.dead_exports).toHaveLength(1);
    expect(result.dead_exports[0].recommendation).toBe('delete_symbol');
  });
});
