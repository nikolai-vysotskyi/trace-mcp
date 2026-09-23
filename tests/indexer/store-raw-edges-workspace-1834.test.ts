/**
 * TRA-1834 — `storeRawEdges` workspace preload rewrite stays behavior-identical.
 *
 * The preload query joined with an OR plus a correlated subquery, which
 * defeats index use and plans as a scan with per-row TEXT comparisons —
 * the B-tree + binCollFunc shape the wedged daemon showed. It was rewritten
 * to PK-equality LEFT JOINs + COALESCE. This test pins the observable
 * contract through the rewrite: same-workspace edges land, cross-workspace
 * `core` edges are dropped, for both symbol-anchored and file-anchored
 * edges (the two rewritten join branches).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { EdgeResolver } from '../../src/indexer/edge-resolver.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';

function makeState(store: Store, registry: PluginRegistry, rootPath: string): PipelineState {
  return {
    store,
    registry,
    config: TraceMcpConfigSchema.parse({ root: rootPath }),
    rootPath,
    workspaces: [
      { name: 'a', path: 'a' },
      { name: 'b', path: 'b' },
    ],
    isIncremental: false,
    changedFileIds: new Set(),
    pendingImports: new Map(),
    fileContentCache: new Map(),
    gitignore: undefined,
  };
}

describe('storeRawEdges workspace preload (TRA-1834)', () => {
  it('keeps same-workspace edges and drops cross-workspace core edges', () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'ws1834-'));
    const db = initializeDatabase(':memory:');
    try {
      const store = new Store(db);
      const resolver = new EdgeResolver(makeState(store, new PluginRegistry(), rootPath));

      const fileA1 = store.insertFile('a/one.ts', 'typescript', 'h1', 10, 'a');
      const fileA2 = store.insertFile('a/two.ts', 'typescript', 'h2', 10, 'a');
      const fileB = store.insertFile('b/other.ts', 'typescript', 'h3', 10, 'b');
      store.insertSymbols(fileA1, [
        {
          symbolId: 'a/one.ts::one#function',
          name: 'one',
          kind: 'function',
          byteStart: 0,
          byteEnd: 5,
        },
      ]);
      store.insertSymbols(fileA2, [
        {
          symbolId: 'a/two.ts::two#function',
          name: 'two',
          kind: 'function',
          byteStart: 0,
          byteEnd: 5,
        },
      ]);
      store.insertSymbols(fileB, [
        {
          symbolId: 'b/other.ts::other#function',
          name: 'other',
          kind: 'function',
          byteStart: 0,
          byteEnd: 5,
        },
      ]);

      resolver.storeRawEdges([
        // Symbol-anchored, same workspace → must land.
        {
          sourceSymbolId: 'a/one.ts::one#function',
          targetSymbolId: 'a/two.ts::two#function',
          edgeType: 'references',
        },
        // Symbol-anchored, cross workspace, core category → must drop.
        {
          sourceSymbolId: 'a/one.ts::one#function',
          targetSymbolId: 'b/other.ts::other#function',
          edgeType: 'references',
        },
        // File-anchored, same workspace → must land.
        {
          sourceNodeType: 'file',
          sourceRefId: fileA1,
          targetNodeType: 'file',
          targetRefId: fileA2,
          edgeType: 'references',
        },
        // File-anchored, cross workspace → must drop.
        {
          sourceNodeType: 'file',
          sourceRefId: fileA1,
          targetNodeType: 'file',
          targetRefId: fileB,
          edgeType: 'references',
        },
      ]);

      const rows = db
        .prepare(
          `SELECT sn.ref_id AS src_ref, tn.ref_id AS tgt_ref
           FROM edges e
           JOIN nodes sn ON sn.id = e.source_node_id
           JOIN nodes tn ON tn.id = e.target_node_id
           JOIN edge_types et ON et.id = e.edge_type_id
           WHERE et.name = 'references'`,
        )
        .all() as Array<{ src_ref: number; tgt_ref: number }>;
      // Exactly the two same-workspace edges; both cross-workspace drops held.
      expect(rows).toHaveLength(2);
    } finally {
      db.close();
      rmSync(rootPath, { recursive: true, force: true });
    }
  });
});
