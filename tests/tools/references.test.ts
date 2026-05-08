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

  it('surfaces resolution_tier on each reference and tallies the summary', () => {
    const target = addSymbol(store, { filePath: 'src/t.ts', name: 'T', kind: 'class' });
    const lspCaller = addSymbol(store, { filePath: 'src/a.ts', name: 'a', kind: 'function' });
    const astCaller = addSymbol(store, { filePath: 'src/b.ts', name: 'b', kind: 'function' });
    const fuzzy = addSymbol(store, { filePath: 'src/c.ts', name: 'c', kind: 'function' });

    store.insertEdge(
      lspCaller.nodeId,
      target.nodeId,
      'calls',
      true,
      undefined,
      false,
      'lsp_resolved',
    );
    store.insertEdge(
      astCaller.nodeId,
      target.nodeId,
      'calls',
      true,
      undefined,
      false,
      'ast_resolved',
    );
    store.insertEdge(fuzzy.nodeId, target.nodeId, 'calls', false, undefined, false, 'text_matched');

    const result = findReferences(store, { symbolId: 'src/t.ts::T#class' });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    for (const ref of val.references) {
      expect(['lsp_resolved', 'ast_resolved', 'ast_inferred', 'text_matched']).toContain(
        ref.resolution_tier,
      );
    }

    expect(val.resolution_tiers.lsp_resolved).toBe(1);
    expect(val.resolution_tiers.ast_resolved).toBe(1);
    expect(val.resolution_tiers.text_matched).toBe(1);
    expect(val.resolution_tiers.ast_inferred).toBe(0);

    const totalByTier =
      val.resolution_tiers.lsp_resolved +
      val.resolution_tiers.ast_resolved +
      val.resolution_tiers.ast_inferred +
      val.resolution_tiers.text_matched;
    expect(totalByTier).toBe(val.total);
  });

  it('returns an empty resolution_tiers summary when nothing references the target', () => {
    addSymbol(store, { filePath: 'src/lonely.ts', name: 'lonely', kind: 'function' });
    const result = findReferences(store, { symbolId: 'src/lonely.ts::lonely#function' });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val.references).toHaveLength(0);
    expect(val.resolution_tiers).toEqual({
      lsp_resolved: 0,
      ast_resolved: 0,
      ast_inferred: 0,
      text_matched: 0,
    });
  });

  describe('ambiguous text_matched filter', () => {
    it('drops text_matched edges when the target name collides with many other symbols', () => {
      // Define seven separate `log` methods across different files — the
      // exact pattern that produced phantom god-nodes in graphify v0.5.5.
      // Then create one text_matched edge into one specific `log`.
      const targetFile = 'src/services/logger.ts';
      const target = addSymbol(store, { filePath: targetFile, name: 'log', kind: 'method' });
      for (let i = 0; i < 6; i++) {
        addSymbol(store, { filePath: `src/other/file${i}.ts`, name: 'log', kind: 'method' });
      }
      const caller = addSymbol(store, {
        filePath: 'src/caller.ts',
        name: 'doStuff',
        kind: 'function',
      });
      const edgeResult = store.insertEdge(
        caller.nodeId,
        target.nodeId,
        'calls',
        true,
        undefined,
        false,
        'text_matched',
      );
      expect(edgeResult.isOk()).toBe(true);

      // Default behavior — ambiguous filter ON — should drop the text_matched edge.
      const filtered = findReferences(store, { symbolId: `${targetFile}::log#method` });
      expect(filtered.isOk()).toBe(true);
      const v = filtered._unsafeUnwrap();
      expect(v.references).toHaveLength(0);
      expect(v.ambiguous_filtered).toBeDefined();
      expect(v.ambiguous_filtered?.dropped).toBe(1);
      expect(v.ambiguous_filtered?.nameCollisions).toBeGreaterThanOrEqual(7);

      // Opt out — caller wants the noisy edges anyway.
      const unfiltered = findReferences(store, {
        symbolId: `${targetFile}::log#method`,
        includeAmbiguousTextMatched: true,
      });
      expect(unfiltered.isOk()).toBe(true);
      expect(unfiltered._unsafeUnwrap().references).toHaveLength(1);
    });

    it('keeps text_matched edges when the name is unique', () => {
      const target = addSymbol(store, {
        filePath: 'src/u.ts',
        name: 'extremelyUniqueWorkerXyz',
        kind: 'function',
      });
      const caller = addSymbol(store, { filePath: 'src/c.ts', name: 'c', kind: 'function' });
      store.insertEdge(
        caller.nodeId,
        target.nodeId,
        'calls',
        true,
        undefined,
        false,
        'text_matched',
      );

      const result = findReferences(store, {
        symbolId: 'src/u.ts::extremelyUniqueWorkerXyz#function',
      });
      expect(result.isOk()).toBe(true);
      const v = result._unsafeUnwrap();
      expect(v.references).toHaveLength(1);
      expect(v.ambiguous_filtered).toBeUndefined();
    });
  });
});
