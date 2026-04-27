/**
 * Stress tests — verify the system handles large codebases without
 * exploding in memory or time. These use in-memory SQLite.
 */
import { describe, it, expect } from 'vitest';
import { createTestStore } from '../test-utils.js';
import { searchFts } from '../../src/db/fts.js';

const KINDS = [
  'class',
  'function',
  'method',
  'interface',
  'variable',
  'type',
  'constant',
  'property',
] as const;
const PREFIXES = [
  'User',
  'Auth',
  'Payment',
  'Order',
  'Product',
  'Cart',
  'Invoice',
  'Config',
  'Logger',
  'Metric',
];
const LANGS = ['typescript', 'python', 'go', 'rust', 'java', 'csharp', 'ruby', 'kotlin'];

function seedDatabase(
  fileCount: number,
  symbolsPerFile: number,
  opts?: { workspaces?: string[]; crossWsEdges?: number },
) {
  const store = createTestStore();
  const db = store.db;

  const insertFile = db.prepare(
    `INSERT INTO files (path, language, content_hash, byte_length, indexed_at, workspace)
     VALUES (?, ?, ?, ?, datetime('now'), ?)`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertNode = db.prepare(`INSERT OR IGNORE INTO nodes (node_type, ref_id) VALUES (?, ?)`);
  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, is_cross_ws)
     VALUES (?, ?, ?, 1, ?)`,
  );

  const edgeType = db.prepare("SELECT id FROM edge_types WHERE name = 'imports'").get() as {
    id: number;
  };
  const workspaces = opts?.workspaces ?? [null as any];
  const fileIds: number[] = [];

  db.transaction(() => {
    for (let i = 0; i < fileCount; i++) {
      const ws = workspaces[i % workspaces.length];
      const lang = LANGS[i % LANGS.length]!;
      const filePath = ws
        ? `packages/${ws}/src/module${Math.floor(i / 10)}/file${i}.ts`
        : `src/modules/module${Math.floor(i / 10)}/file${i}.ts`;

      const result = insertFile.run(filePath, lang, `hash_${i}`, 500 + (i % 5000), ws ?? null);
      const fileId = Number(result.lastInsertRowid);
      insertNode.run('file', fileId);
      fileIds.push(fileId);

      for (let j = 0; j < symbolsPerFile; j++) {
        const prefix = PREFIXES[j % PREFIXES.length]!;
        const kind = KINDS[j % KINDS.length]!;
        const name = `${prefix}${kind.charAt(0).toUpperCase() + kind.slice(1)}${i}_${j}`;
        const symbolId = `${filePath}::${name}#${kind}`;
        const fqn = ws
          ? `${ws}.module${Math.floor(i / 10)}.${name}`
          : `module${Math.floor(i / 10)}.${name}`;
        const meta = j % 3 === 0 ? JSON.stringify({ exported: 1 }) : null;

        const symResult = insertSymbol.run(
          fileId,
          symbolId,
          name,
          kind,
          fqn,
          j * 100,
          (j + 1) * 100,
          j * 5 + 1,
          (j + 1) * 5,
          meta,
        );
        insertNode.run('symbol', Number(symResult.lastInsertRowid));
      }
    }

    // Add import edges between consecutive files
    for (let i = 0; i < fileIds.length - 1; i++) {
      const srcNode = store.getNodeId('file', fileIds[i]!);
      const tgtNode = store.getNodeId('file', fileIds[i + 1]!);
      if (srcNode && tgtNode) {
        const isCrossWs =
          workspaces.length > 1 && i % workspaces.length === workspaces.length - 1 ? 1 : 0;
        insertEdge.run(srcNode, tgtNode, edgeType.id, isCrossWs);
      }
    }

    // Additional cross-workspace edges
    if (opts?.crossWsEdges) {
      const step = Math.max(1, Math.floor(fileIds.length / opts.crossWsEdges));
      for (let i = 0; i < opts.crossWsEdges && i * step + step < fileIds.length; i++) {
        const srcNode = store.getNodeId('file', fileIds[i * step]!);
        const tgtNode = store.getNodeId('file', fileIds[i * step + step]!);
        if (srcNode && tgtNode) {
          insertEdge.run(srcNode, tgtNode, edgeType.id, 1);
        }
      }
    }
  })();

  return { db, store };
}

describe('Stress: 10K files', () => {
  it('seeds and queries 10,000 files with ~50K symbols', () => {
    const start = Date.now();
    const { store } = seedDatabase(10_000, 5);
    const seedTime = Date.now() - start;

    const stats = store.getStats();
    expect(stats.totalFiles).toBe(10_000);
    expect(stats.totalSymbols).toBe(50_000);
    expect(stats.totalEdges).toBeGreaterThan(9_000);

    // Seeding 10K files should complete within 10s
    expect(seedTime).toBeLessThan(10_000);
    console.log(`Seed 10K files + 50K symbols: ${seedTime}ms`);
  }, 30_000);

  it('FTS search on 50K symbols returns in <200ms', () => {
    const { db } = seedDatabase(10_000, 5);

    const start = Date.now();
    const results = searchFts(db, 'module0', 20, 0);
    const elapsed = Date.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
    console.log(`FTS "module0" on 50K symbols: ${elapsed}ms, ${results.length} results`);
  }, 30_000);

  it('graph traversal depth 5 on 10K nodes completes in <500ms', () => {
    const { store } = seedDatabase(10_000, 5);

    const files = store.getAllFiles();
    const startNodeId = store.getNodeId('file', files[0]!.id);
    expect(startNodeId).toBeDefined();

    const start = Date.now();
    const edges = store.traverseEdges(startNodeId!, 'outgoing', 5);
    const elapsed = Date.now() - start;

    expect(edges.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
    console.log(`CTE depth-5 traversal on 10K files: ${elapsed}ms, ${edges.length} edges`);
  }, 30_000);

  it('getAllFiles on 10K files returns in <100ms', () => {
    const { store } = seedDatabase(10_000, 5);

    const start = Date.now();
    const files = store.getAllFiles();
    const elapsed = Date.now() - start;

    expect(files.length).toBe(10_000);
    expect(elapsed).toBeLessThan(100);
    console.log(`getAllFiles (10K): ${elapsed}ms`);
  }, 30_000);
});

describe('Stress: workspace queries at scale', () => {
  it('workspace stats on 5K files across 5 workspaces', () => {
    const { store } = seedDatabase(5_000, 4, {
      workspaces: ['core', 'api', 'web', 'mobile', 'shared'],
      crossWsEdges: 100,
    });

    const start = Date.now();
    const wsStats = store.getWorkspaceStats();
    const elapsed = Date.now() - start;

    expect(wsStats.length).toBe(5);
    expect(wsStats.reduce((sum, ws) => sum + ws.file_count, 0)).toBe(5_000);
    expect(elapsed).toBeLessThan(500);
    console.log(`Workspace stats (5 ws, 5K files): ${elapsed}ms`);
  }, 30_000);

  it('cross-workspace dependency graph resolves in <500ms', () => {
    const { store } = seedDatabase(5_000, 4, {
      workspaces: ['core', 'api', 'web', 'mobile', 'shared'],
      crossWsEdges: 200,
    });

    const start = Date.now();
    const deps = store.getWorkspaceDependencyGraph();
    const elapsed = Date.now() - start;

    expect(deps.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
    console.log(
      `Cross-workspace dep graph (5 ws, 200 xws edges): ${elapsed}ms, ${deps.length} dependencies`,
    );
  }, 30_000);
});

describe('Stress: batch queries', () => {
  it('getSymbolsByIds with 1000 IDs completes in <100ms', () => {
    const { store } = seedDatabase(1_000, 5);

    const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
    const start = Date.now();
    const map = store.getSymbolsByIds(ids);
    const elapsed = Date.now() - start;

    expect(map.size).toBeGreaterThan(500);
    expect(elapsed).toBeLessThan(100);
    console.log(`getSymbolsByIds (1000 IDs): ${elapsed}ms, ${map.size} found`);
  }, 15_000);

  it('getEdgesForNodesBatch with 500 node IDs', () => {
    const { store } = seedDatabase(2_000, 3);

    const nodeIds = Array.from({ length: 500 }, (_, i) => i + 1);
    const start = Date.now();
    const edges = store.getEdgesForNodesBatch(nodeIds);
    const elapsed = Date.now() - start;

    expect(edges.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
    console.log(`getEdgesForNodesBatch (500 nodes): ${elapsed}ms, ${edges.length} edges`);
  }, 15_000);
});
