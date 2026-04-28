import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { findReferences } from '../../src/tools/framework/references.js';
import { createTestStore } from '../test-utils.js';

function addSymbol(
  store: Store,
  opts: {
    filePath: string;
    name: string;
    kind: string;
    fqn?: string;
  },
): { fileId: number; symbolDbId: number; nodeId: number } {
  const file = store.getFile(opts.filePath);
  const fileId = file ? file.id : store.insertFile(opts.filePath, 'typescript', null, null);
  const symbolDbId = store.insertSymbol(fileId, {
    symbolId: `${opts.filePath}::${opts.name}#${opts.kind}`,
    name: opts.name,
    kind: opts.kind as any,
    fqn: opts.fqn,
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 10,
  });
  return { fileId, symbolDbId, nodeId: store.getNodeId('symbol', symbolDbId)! };
}

describe('findReferences', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    store.ensureEdgeType('calls', 'code', 'Function calls');
    store.ensureEdgeType('imports', 'code', 'Import statements');
    store.ensureEdgeType('references', 'code', 'Symbol references');
  });

  it('returns NOT_FOUND for non-existent symbol', () => {
    const result = findReferences(store, { symbolId: 'nope' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });

  it('returns empty references when no incoming edges', () => {
    addSymbol(store, { filePath: 'src/a.ts', name: 'lonely', kind: 'function' });
    const result = findReferences(store, { symbolId: 'src/a.ts::lonely#function' });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val.references).toHaveLength(0);
  });

  it('finds multiple incoming edges of different types', () => {
    const target = addSymbol(store, { filePath: 'src/target.ts', name: 'Target', kind: 'class' });
    const caller = addSymbol(store, {
      filePath: 'src/caller.ts',
      name: 'caller',
      kind: 'function',
    });
    const importer = addSymbol(store, {
      filePath: 'src/importer.ts',
      name: 'importer',
      kind: 'function',
    });

    store.insertEdge(caller.nodeId, target.nodeId, 'calls');
    store.insertEdge(importer.nodeId, target.nodeId, 'references');

    const result = findReferences(store, { symbolId: 'src/target.ts::Target#class' });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val.references.length).toBeGreaterThanOrEqual(2);
    const edgeTypes = val.references.map((r) => r.edge_type);
    expect(edgeTypes).toContain('calls');
    expect(edgeTypes).toContain('references');
  });

  it('finds references by fqn', () => {
    const target = addSymbol(store, {
      filePath: 'src/svc.ts',
      name: 'UserService',
      kind: 'class',
      fqn: 'app.UserService',
    });
    const user = addSymbol(store, { filePath: 'src/ctrl.ts', name: 'ctrl', kind: 'function' });
    store.insertEdge(user.nodeId, target.nodeId, 'calls');

    const result = findReferences(store, { fqn: 'app.UserService' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().references).toHaveLength(1);
  });

  it('finds references by filePath', () => {
    const fileId = store.insertFile('src/data.ts', 'typescript', null, null);
    const fileNodeId = store.getNodeId('file', fileId)!;
    const importer = addSymbol(store, {
      filePath: 'src/importer.ts',
      name: 'imp',
      kind: 'function',
    });
    store.insertEdge(importer.nodeId, fileNodeId, 'imports');

    const result = findReferences(store, { filePath: 'src/data.ts' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().references).toHaveLength(1);
  });
});
