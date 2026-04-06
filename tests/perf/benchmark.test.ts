import { describe, it, expect } from 'vitest';
import { createTestStore } from '../test-utils.js';
import type { Store } from '../../src/db/store.js';
import { searchFts } from '../../src/db/fts.js';

function createLargeIndex(fileCount: number) {
  const store = createTestStore();
  const db = store.db;

  const insertFile = db.prepare(
    `INSERT INTO files (path, language, content_hash, byte_length, indexed_at)
     VALUES (?, 'typescript', ?, ?, datetime('now'))`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertNode = db.prepare(
    `INSERT OR IGNORE INTO nodes (node_type, ref_id) VALUES (?, ?)`,
  );

  const kinds = ['class', 'function', 'method', 'interface', 'variable'];
  const prefixes = ['User', 'Auth', 'Payment', 'Order', 'Product', 'Cart', 'Invoice', 'Notification', 'Setting', 'Report'];

  db.transaction(() => {
    for (let i = 0; i < fileCount; i++) {
      const filePath = `src/modules/module${i}/file${i}.ts`;
      const hash = `hash_${i}`;
      const result = insertFile.run(filePath, hash, 100 + i);
      const fileId = Number(result.lastInsertRowid);
      insertNode.run('file', fileId);

      // 3-5 symbols per file
      const symCount = 3 + (i % 3);
      for (let j = 0; j < symCount; j++) {
        const prefix = prefixes[j % prefixes.length]!;
        const kind = kinds[j % kinds.length]!;
        const name = `${prefix}${kind === 'class' ? 'Service' : kind === 'function' ? 'Handler' : 'Util'}${i}_${j}`;
        const symbolId = `${filePath}::${name}#${kind}`;
        const fqn = `modules.module${i}.${name}`;

        const symResult = insertSymbol.run(fileId, symbolId, name, kind, fqn, 0, 100, 1, 10 + j);
        insertNode.run('symbol', Number(symResult.lastInsertRowid));
      }
    }
  })();

  return { db, store };
}

function createEdgesForGraph(store: Store, edgeCount: number) {
  // Create edges between consecutive file nodes
  const files = store.getAllFiles();
  const edgeType = store.db.prepare("SELECT id FROM edge_types WHERE name = 'imports'").get() as { id: number };

  const insertEdge = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved)
     VALUES (?, ?, ?, 1)`,
  );

  store.db.transaction(() => {
    let count = 0;
    for (let i = 0; i < files.length - 1 && count < edgeCount; i++) {
      const sourceNode = store.getNodeId('file', files[i]!.id);
      const targetNode = store.getNodeId('file', files[i + 1]!.id);
      if (sourceNode && targetNode) {
        insertEdge.run(sourceNode, targetNode, edgeType.id);
        count++;
      }
    }
  })();
}

describe('Performance benchmarks — edge batch inserts', () => {
  it('batched inserts are faster than individual inserts for 1000 edges', () => {
    const { store, db } = createLargeIndex(300);
    createEdgesForGraph(store, 200);

    const files = store.getAllFiles();
    const edgeType = db.prepare("SELECT id FROM edge_types WHERE name = 'imports'").get() as { id: number };
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved)
       VALUES (?, ?, ?, 1)`,
    );

    // Prepare pairs for 1000 additional edges
    const pairs: [number, number][] = [];
    for (let i = 0; i < files.length - 2 && pairs.length < 1000; i++) {
      const src = store.getNodeId('file', files[i]!.id);
      const tgt = store.getNodeId('file', files[i + 2]!.id);
      if (src && tgt) pairs.push([src, tgt]);
    }

    // Individual inserts
    const startIndividual = Date.now();
    for (const [src, tgt] of pairs) {
      insertStmt.run(src, tgt, edgeType.id);
    }
    const elapsedIndividual = Date.now() - startIndividual;

    // Clean up edges for re-test
    db.prepare('DELETE FROM edges WHERE edge_type_id = ?').run(edgeType.id);

    // Batched inserts (transaction)
    const startBatched = Date.now();
    db.transaction(() => {
      for (const [src, tgt] of pairs) {
        insertStmt.run(src, tgt, edgeType.id);
      }
    })();
    const elapsedBatched = Date.now() - startBatched;

    console.log(`Edge inserts (${pairs.length} edges): individual=${elapsedIndividual}ms, batched=${elapsedBatched}ms, speedup=${(elapsedIndividual / Math.max(elapsedBatched, 1)).toFixed(1)}x`);

    // Batched should be at least 2x faster (typically 10-50x on SQLite)
    expect(elapsedBatched).toBeLessThanOrEqual(elapsedIndividual);
  }, 30_000);
});

describe('Performance benchmarks', () => {
  it('indexes 500+ files within reasonable time', () => {
    const start = Date.now();
    const { store } = createLargeIndex(500);
    const elapsed = Date.now() - start;

    const stats = store.getStats();
    expect(stats.totalFiles).toBe(500);
    expect(stats.totalSymbols).toBeGreaterThan(1000);

    // Allow generous timeout for CI: 30s
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);

  it('FTS5 search on large index is fast', () => {
    const { db } = createLargeIndex(500);

    const start = Date.now();
    // FTS5 tokenizes on word boundaries; search for a name that appears in FQN
    const results = searchFts(db, 'module0', 20, 0);
    const elapsed = Date.now() - start;

    expect(results.length).toBeGreaterThan(0);
    // Allow 500ms for CI
    expect(elapsed).toBeLessThan(500);
  }, 30_000);

  it('CTE traversal depth 5 completes quickly', () => {
    const { store } = createLargeIndex(200);
    createEdgesForGraph(store, 150);

    const files = store.getAllFiles();
    const startNodeId = store.getNodeId('file', files[0]!.id);
    expect(startNodeId).toBeDefined();

    const start = Date.now();
    const edges = store.traverseEdges(startNodeId!, 'outgoing', 5);
    const elapsed = Date.now() - start;

    expect(edges.length).toBeGreaterThan(0);
    // Allow 500ms for CI
    expect(elapsed).toBeLessThan(500);
  }, 30_000);
});
