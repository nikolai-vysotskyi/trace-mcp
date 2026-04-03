import { describe, it, expect } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { searchFts } from '../../src/db/fts.js';

function createLargeIndex(fileCount: number) {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);

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
