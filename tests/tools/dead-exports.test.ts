import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../src/db/store.js';
import { getDeadExports } from '../../src/tools/analysis/introspect.js';
import { createTestStore } from '../test-utils.js';

function addExportedSymbol(store: Store, filePath: string, name: string, kind: string): number {
  let file = store.getFile(filePath);
  const fileId = file ? file.id : store.insertFile(filePath, 'typescript', null, null);
  return store.insertSymbol(fileId, {
    symbolId: `${filePath}::${name}#${kind}`,
    name,
    kind: kind as any,
    byteStart: 0, byteEnd: 100, lineStart: 1, lineEnd: 10,
    metadata: { exported: 1 },
  });
}

function addImportEdge(store: Store, fromFile: string, toFile: string, specifiers: string[]): void {
  let srcFile = store.getFile(fromFile);
  const srcFileId = srcFile ? srcFile.id : store.insertFile(fromFile, 'typescript', null, null);
  let tgtFile = store.getFile(toFile);
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
});
