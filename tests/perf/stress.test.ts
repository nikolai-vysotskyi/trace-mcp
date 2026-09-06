/**
 * Stress tests — verify the system handles large codebases without
 * exploding in memory or time. These use in-memory SQLite.
 *
 * The seeder lives in `large-index.ts`; `scale-rangeerror.test.ts` uses the
 * same one at the size where V8's argument limit starts to bite.
 */
import { describe, expect, it } from 'vitest';
import { searchFts } from '../../src/db/fts.js';
import { seedLargeIndex as seedDatabase } from './large-index.js';

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
