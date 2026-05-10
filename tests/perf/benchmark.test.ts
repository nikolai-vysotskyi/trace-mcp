import { describe, expect, it } from 'vitest';
import { searchFts } from '../../src/db/fts.js';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';

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
  const insertNode = db.prepare(`INSERT OR IGNORE INTO nodes (node_type, ref_id) VALUES (?, ?)`);

  const kinds = ['class', 'function', 'method', 'interface', 'variable'];
  const prefixes = [
    'User',
    'Auth',
    'Payment',
    'Order',
    'Product',
    'Cart',
    'Invoice',
    'Notification',
    'Setting',
    'Report',
  ];

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
  const edgeType = store.db.prepare("SELECT id FROM edge_types WHERE name = 'imports'").get() as {
    id: number;
  };

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
  // Timing-sensitive benchmark — at small edge counts (~1000 inserts complete
  // in <2ms on a modern runner) Date.now()'s 1ms granularity makes the
  // ordering assertion flaky: a sub-ms individual run rounds to 1ms, a
  // sub-ms batched run rounds to 2ms, and the test fails despite the
  // optimisation working as designed (windows-latest, then macos-latest).
  // Mitigation: use performance.now() for fractional-ms timing, scale up
  // to 5000 inserts so the absolute time is well above the noise floor,
  // and tolerate a small jitter band so a single GC pause cannot invert
  // the comparison.
  it('batched inserts are faster than individual inserts for 5000 edges', () => {
    const { store, db } = createLargeIndex(300);
    createEdgesForGraph(store, 200);

    const files = store.getAllFiles();
    const edgeType = db.prepare("SELECT id FROM edge_types WHERE name = 'imports'").get() as {
      id: number;
    };
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved)
       VALUES (?, ?, ?, 1)`,
    );

    // Build 5000 distinct (src, tgt) pairs by combining different file
    // offsets; keep cycling until we have enough non-self-edges.
    const pairs: [number, number][] = [];
    for (let offset = 1; offset < files.length && pairs.length < 5000; offset++) {
      for (let i = 0; i + offset < files.length && pairs.length < 5000; i++) {
        const src = store.getNodeId('file', files[i]!.id);
        const tgt = store.getNodeId('file', files[i + offset]!.id);
        if (src && tgt) pairs.push([src, tgt]);
      }
    }

    // Individual inserts
    const startIndividual = performance.now();
    for (const [src, tgt] of pairs) {
      insertStmt.run(src, tgt, edgeType.id);
    }
    const elapsedIndividual = performance.now() - startIndividual;

    // Clean up edges for re-test
    db.prepare('DELETE FROM edges WHERE edge_type_id = ?').run(edgeType.id);

    // Batched inserts (transaction)
    const startBatched = performance.now();
    db.transaction(() => {
      for (const [src, tgt] of pairs) {
        insertStmt.run(src, tgt, edgeType.id);
      }
    })();
    const elapsedBatched = performance.now() - startBatched;

    console.log(
      `Edge inserts (${pairs.length} edges): individual=${elapsedIndividual.toFixed(2)}ms, batched=${elapsedBatched.toFixed(2)}ms, speedup=${(elapsedIndividual / Math.max(elapsedBatched, 0.01)).toFixed(1)}x`,
    );

    // Batched should never be slower in steady state. Allow a small
    // jitter band (5ms) so a single GC pause or scheduler hiccup during
    // the batched run cannot invert the comparison — the speedup we
    // care about is order-of-magnitude (typically 10-50x on SQLite).
    expect(elapsedBatched).toBeLessThanOrEqual(elapsedIndividual + 5);
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
