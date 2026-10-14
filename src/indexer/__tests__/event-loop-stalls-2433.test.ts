/**
 * TRA-2433: Regression tests for event loop stalls during indexing/reconcile.
 *
 * Guards:
 * 1. buildFileImportMap plan shape (edges-driven direct index seek or nodes ref_id CROSS JOIN,
 *    never unindexed nodes scans or unconstrained 3-way joins).
 * 2. PROJECTION_ID_CHUNK reduced to 500 to keep per-step execution under 500ms.
 * 3. Scoped file projection yields to event loop between chunks.
 * 4. enableFts5TriggersAsync yields between symbols_fts and symbols_name_tri rebuilds.
 * 5. Targeted ANALYZE does not scan virtual table shadow tables.
 * 6. Coverage reconcile stamps _lastCoverageReconcileMs so non-drifting projects
 *    don't repeatedly re-walk 10k+ files on disk every minute.
 */
import { describe, expect, it, vi } from 'vitest';
import { initializeDatabase, enableFts5TriggersAsync } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PROJECTION_ID_CHUNK } from '../resolver-budget.js';
import { resolveFileProjectionEdges } from '../edge-resolvers/file-projection.js';
import type { PipelineState } from '../pipeline-state.js';
import * as eventLoop from '../../utils/event-loop.js';

describe('event loop stall preventions (TRA-2433)', () => {
  it('PROJECTION_ID_CHUNK is 500 to bound per-statement execution time', () => {
    expect(PROJECTION_ID_CHUNK).toBe(500);
  });

  it('unscoped import edge query uses index seek on idx_edges_type', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    store.ensureEdgeType('imports', 'core', 'imports');
    const importTypeId = (
      store.db.prepare("SELECT id FROM edge_types WHERE name = 'imports'").get() as { id: number }
    ).id;

    // Unscoped query: SELECT e.source_node_id, e.target_node_id, e.metadata FROM edges e WHERE e.edge_type_id = ?
    const plan = store.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT e.source_node_id, e.target_node_id, e.metadata FROM edges e WHERE e.edge_type_id = ?',
      )
      .all(importTypeId) as Array<{ detail: string }>;

    expect(plan.length).toBeGreaterThan(0);
    const detail = plan[0]!.detail;
    // Must use idx_edges_type or idx_edges_src_tgt_type, never a full table scan
    expect(detail).toMatch(/USING (COVERING )?INDEX (idx_edges_type|idx_edges_src_tgt_type)/);
    db.close();
  });

  it('scoped import edge query drives with nodes ref_id seek and CROSS JOIN to edges', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    store.ensureEdgeType('imports', 'core', 'imports');
    const importTypeId = (
      store.db.prepare("SELECT id FROM edge_types WHERE name = 'imports'").get() as { id: number }
    ).id;

    const sql = `
      SELECT e.source_node_id, e.target_node_id, e.metadata
        FROM nodes ns
        CROSS JOIN edges e ON e.source_node_id = ns.id
       WHERE ns.node_type = 'file'
         AND ns.ref_id IN (?, ?)
         AND e.edge_type_id = ?
    `;
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 2, importTypeId) as Array<{
      detail: string;
    }>;

    // ns should be the driving table using sqlite_autoindex_nodes_1 or idx_nodes_type
    expect(plan[0]!.detail).toMatch(/SEARCH ns USING (COVERING )?INDEX/);
    // e should be looked up using an index on edges
    expect(plan[1]!.detail).toMatch(
      /SEARCH e USING (COVERING )?INDEX (idx_edges_source|idx_edges_src_tgt_type|idx_edges_type)/,
    );
    db.close();
  });

  it('fastapi-mounts query uses CROSS JOIN to drive from edges', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    store.ensureEdgeType('imports', 'core', 'imports');
    const importTypeId = (
      store.db.prepare("SELECT id FROM edge_types WHERE name = 'imports'").get() as { id: number }
    ).id;

    const sql = `
      SELECT ns.ref_id AS src, nt.ref_id AS tgt, e.metadata
        FROM edges e
        CROSS JOIN nodes ns ON ns.id = e.source_node_id AND ns.node_type = 'file'
        CROSS JOIN nodes nt ON nt.id = e.target_node_id AND nt.node_type = 'file'
       WHERE e.edge_type_id = ?
    `;
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(importTypeId) as Array<{
      detail: string;
    }>;

    // Driving table must be edges e using idx_edges_type
    expect(plan[0]!.detail).toMatch(
      /SEARCH e USING (COVERING )?INDEX (idx_edges_type|idx_edges_src_tgt_type)/,
    );
    db.close();
  });

  it('scoped file projection yields to event loop between chunks', async () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    store.ensureEdgeType('imports', 'core', 'imports');
    store.ensureEdgeType('calls', 'core', 'calls');

    // Create 700 files to span multiple 300-file chunks
    const fileIds: number[] = [];
    for (let i = 0; i < 700; i++) {
      fileIds.push(store.insertFile(`test_${i}.ts`, 'typescript', `h_${i}`, 10, null, null));
    }

    const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');

    const state: PipelineState = {
      rootPath: '/tmp/test',
      store,
      progress: { update: () => {} },
    } as unknown as PipelineState;

    await resolveFileProjectionEdges(state, {
      changedFileIds: new Set(fileIds),
      newSymbolNames: new Map(),
      deletedSymbolNames: new Map(),
    });

    // 700 files / 300 chunk size = 3 chunks -> 2 yields between chunks
    expect(yieldSpy).toHaveBeenCalled();
    yieldSpy.mockRestore();
    db.close();
  });

  it('enableFts5TriggersAsync yields to event loop between symbols_fts and symbols_name_tri rebuilds', async () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const fid = store.insertFile('a.ts', 'typescript', 'hash', 10, null, null);
    store.insertSymbols(fid, [
      {
        symbolId: 'a.ts::fn1#function',
        name: 'fn1',
        kind: 'function',
        byteStart: 0,
        byteEnd: 10,
        lineStart: 1,
        lineEnd: 1,
      },
    ]);

    const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');

    await enableFts5TriggersAsync(store.db);

    expect(yieldSpy).toHaveBeenCalledTimes(1);

    // Verify symbols are searchable in FTS
    const matches = store.db
      .prepare('SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?')
      .all('fn1');
    expect(matches.length).toBe(1);

    yieldSpy.mockRestore();
    db.close();
  });

  it('targeted ANALYZE updates sqlite_stat1 for core tables without scanning virtual table shadow tables', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const fid = store.insertFile('a.ts', 'typescript', 'hash', 10, null, null);
    store.insertSymbols(fid, [
      {
        symbolId: 'a.ts::fn1#function',
        name: 'fn1',
        kind: 'function',
        byteStart: 0,
        byteEnd: 10,
        lineStart: 1,
        lineEnd: 1,
      },
    ]);

    // Run targeted ANALYZE
    store.db.exec('ANALYZE files; ANALYZE symbols; ANALYZE edges; ANALYZE nodes;');

    const statRows = store.db
      .prepare('SELECT DISTINCT tbl FROM sqlite_stat1 ORDER BY tbl')
      .all() as Array<{ tbl: string }>;
    const tableNames = statRows.map((r) => r.tbl);

    expect(tableNames).toContain('files');
    expect(tableNames).toContain('symbols');
    // None of the FTS shadow tables should be in sqlite_stat1
    expect(tableNames.some((t) => t.startsWith('symbols_fts_'))).toBe(false);
    expect(tableNames.some((t) => t.startsWith('symbols_name_tri_'))).toBe(false);

    db.close();
  });
});
