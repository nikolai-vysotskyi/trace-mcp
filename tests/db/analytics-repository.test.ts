import { describe, expect, it } from 'vitest';
import { createTestStore } from '../test-utils.js';

describe('AnalyticsRepository — env vars', () => {
  it('round-trips env vars and retrieves them by file ordered by line', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/.env', 'dotenv', 'h1', 100);

    const id1 = store.analytics.insertEnvVar(fileId, {
      key: 'DATABASE_URL',
      valueType: 'string',
      valueFormat: 'uri',
      comment: 'Primary PostgreSQL database',
      quoted: false,
      line: 10,
    });

    const id2 = store.analytics.insertEnvVar(fileId, {
      key: 'APP_KEY',
      valueType: 'string',
      valueFormat: null,
      comment: null,
      quoted: true,
      line: 2,
    });

    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(id1);

    const rows = store.analytics.getEnvVarsByFile(fileId);
    expect(rows).toHaveLength(2);
    // Ordered by line ascending: line 2 comes before line 10
    expect(rows[0].key).toBe('APP_KEY');
    expect(rows[0].line).toBe(2);
    expect(rows[0].quoted).toBe(1);

    expect(rows[1].key).toBe('DATABASE_URL');
    expect(rows[1].line).toBe(10);
    expect(rows[1].value_format).toBe('uri');
    expect(rows[1].comment).toBe('Primary PostgreSQL database');
    expect(rows[1].quoted).toBe(0);
  });

  it('deletes env vars by fileId without affecting other files', () => {
    const store = createTestStore();
    const file1 = store.insertFile('src/.env', 'dotenv', 'h1', 50);
    const file2 = store.insertFile('src/.env.local', 'dotenv', 'h2', 50);

    store.analytics.insertEnvVar(file1, {
      key: 'PORT',
      valueType: 'number',
      valueFormat: null,
      comment: null,
      quoted: false,
      line: 1,
    });
    store.analytics.insertEnvVar(file2, {
      key: 'PORT',
      valueType: 'number',
      valueFormat: null,
      comment: null,
      quoted: false,
      line: 1,
    });

    expect(store.analytics.getEnvVarsByFile(file1)).toHaveLength(1);
    expect(store.analytics.getEnvVarsByFile(file2)).toHaveLength(1);

    store.analytics.deleteEnvVarsByFile(file1);

    expect(store.analytics.getEnvVarsByFile(file1)).toHaveLength(0);
    expect(store.analytics.getEnvVarsByFile(file2)).toHaveLength(1);
  });

  it('getAllEnvVars joins file path and orders by path then line', () => {
    const store = createTestStore();
    const fileB = store.insertFile('b.env', 'dotenv', 'hB', 20);
    const fileA = store.insertFile('a.env', 'dotenv', 'hA', 20);

    store.analytics.insertEnvVar(fileB, {
      key: 'B_VAR',
      valueType: 'string',
      valueFormat: null,
      comment: null,
      quoted: false,
      line: 1,
    });
    store.analytics.insertEnvVar(fileA, {
      key: 'A_VAR_2',
      valueType: 'string',
      valueFormat: null,
      comment: null,
      quoted: false,
      line: 5,
    });
    store.analytics.insertEnvVar(fileA, {
      key: 'A_VAR_1',
      valueType: 'string',
      valueFormat: null,
      comment: null,
      quoted: false,
      line: 1,
    });

    const all = store.analytics.getAllEnvVars();
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.file_path + ':' + r.key)).toEqual([
      'a.env:A_VAR_1',
      'a.env:A_VAR_2',
      'b.env:B_VAR',
    ]);
  });

  it('searchEnvVars finds matching variables by substring pattern', () => {
    const store = createTestStore();
    const file = store.insertFile('.env', 'dotenv', 'h', 10);

    store.analytics.insertEnvVar(file, {
      key: 'AWS_ACCESS_KEY_ID',
      valueType: 'string',
      valueFormat: null,
      comment: null,
      quoted: false,
      line: 1,
    });
    store.analytics.insertEnvVar(file, {
      key: 'AWS_SECRET_ACCESS_KEY',
      valueType: 'string',
      valueFormat: null,
      comment: null,
      quoted: false,
      line: 2,
    });
    store.analytics.insertEnvVar(file, {
      key: 'DATABASE_HOST',
      valueType: 'string',
      valueFormat: null,
      comment: null,
      quoted: false,
      line: 3,
    });

    const awsVars = store.analytics.searchEnvVars('ACCESS');
    expect(awsVars.map((r) => r.key)).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);

    const dbVars = store.analytics.searchEnvVars('DATABASE');
    expect(dbVars.map((r) => r.key)).toEqual(['DATABASE_HOST']);

    const empty = store.analytics.searchEnvVars('NON_EXISTENT');
    expect(empty).toEqual([]);
  });
});

describe('AnalyticsRepository — workspace stats', () => {
  it('aggregates file count, symbol count, and distinct languages per workspace', () => {
    const store = createTestStore();

    const file1 = store.insertFile('backend/a.ts', 'typescript', 'h1', 100, 'backend');
    const file2 = store.insertFile('backend/b.js', 'javascript', 'h2', 100, 'backend');
    const file3 = store.insertFile('frontend/App.tsx', 'typescript', 'h3', 100, 'frontend');
    // File without workspace should be omitted from workspace stats
    store.insertFile('root.config.js', 'javascript', 'h4', 50, null);

    store.insertSymbol(file1, {
      symbolId: 'backend/a.ts::User#class',
      name: 'User',
      kind: 'class',
      byteStart: 0,
      byteEnd: 10,
    });
    store.insertSymbol(file1, {
      symbolId: 'backend/a.ts::findUser#function',
      name: 'findUser',
      kind: 'function',
      byteStart: 11,
      byteEnd: 20,
    });
    store.insertSymbol(file3, {
      symbolId: 'frontend/App.tsx::App#function',
      name: 'App',
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
    });

    const stats = store.analytics.getWorkspaceStats();
    expect(stats).toHaveLength(2);

    // backend has 2 files, so it comes first (ORDER BY file_count DESC)
    expect(stats[0].workspace).toBe('backend');
    expect(stats[0].file_count).toBe(2);
    expect(stats[0].symbol_count).toBe(2);
    const backendLangs = (stats[0].languages ?? '').split(',');
    expect(backendLangs.sort()).toEqual(['javascript', 'typescript']);

    expect(stats[1].workspace).toBe('frontend');
    expect(stats[1].file_count).toBe(1);
    expect(stats[1].symbol_count).toBe(1);
    expect(stats[1].languages).toBe('typescript');
  });
});

describe('AnalyticsRepository — cross-workspace graph', () => {
  it('retrieves cross-workspace edges with resolved symbols, files, and workspaces', () => {
    const store = createTestStore();

    const fileFe = store.insertFile('packages/fe/Button.tsx', 'typescript', 'h1', 100, 'fe');
    const fileBe = store.insertFile('packages/be/api.ts', 'typescript', 'h2', 100, 'be');

    const symFe = store.insertSymbol(fileFe, {
      symbolId: 'packages/fe/Button.tsx::Button#function',
      name: 'Button',
      kind: 'function',
      byteStart: 0,
      byteEnd: 20,
    });
    const symBe = store.insertSymbol(fileBe, {
      symbolId: 'packages/be/api.ts::fetchData#function',
      name: 'fetchData',
      kind: 'function',
      byteStart: 0,
      byteEnd: 20,
    });

    const nodeFeSym = store.graph.getNodeId('symbol', symFe)!;
    const nodeBeSym = store.graph.getNodeId('symbol', symBe)!;
    const nodeFeFile = store.graph.getNodeId('file', fileFe)!;
    const nodeBeFile = store.graph.getNodeId('file', fileBe)!;

    store.graph.ensureEdgeType('calls', 'usage', 'calls function');
    store.graph.ensureEdgeType('imports', 'dependency', 'imports module');

    // 1. Cross-workspace edge (symbol -> symbol)
    store.graph.insertEdge(nodeFeSym, nodeBeSym, 'calls', true, undefined, true);
    // 2. Cross-workspace edge (file -> file)
    store.graph.insertEdge(nodeFeFile, nodeBeFile, 'imports', true, undefined, true);
    // 3. Intra-workspace edge (is_cross_ws = false)
    store.graph.insertEdge(nodeFeFile, nodeFeSym, 'imports', true, undefined, false);

    const crossEdges = store.analytics.getCrossWorkspaceEdges();
    expect(crossEdges).toHaveLength(2);

    const callEdge = crossEdges.find((e) => e.edge_type === 'calls');
    expect(callEdge).toBeDefined();
    expect(callEdge.source_workspace).toBe('fe');
    expect(callEdge.source_path).toBe('packages/fe/Button.tsx');
    expect(callEdge.source_symbol).toBe('Button');
    expect(callEdge.source_kind).toBe('function');
    expect(callEdge.target_workspace).toBe('be');
    expect(callEdge.target_path).toBe('packages/be/api.ts');
    expect(callEdge.target_symbol).toBe('fetchData');
    expect(callEdge.target_kind).toBe('function');

    const importEdge = crossEdges.find((e) => e.edge_type === 'imports');
    expect(importEdge).toBeDefined();
    expect(importEdge.source_workspace).toBe('fe');
    expect(importEdge.source_path).toBe('packages/fe/Button.tsx');
    expect(importEdge.source_symbol).toBeNull();
    expect(importEdge.target_workspace).toBe('be');
    expect(importEdge.target_path).toBe('packages/be/api.ts');
    expect(importEdge.target_symbol).toBeNull();
  });

  it('aggregates workspace dependency graph excluding self-workspace edges', () => {
    const store = createTestStore();

    const fileA1 = store.insertFile('app/a1.ts', 'typescript', 'h', 10, 'app');
    const fileA2 = store.insertFile('app/a2.ts', 'typescript', 'h', 10, 'app');
    const fileB = store.insertFile('lib/b.ts', 'typescript', 'h', 10, 'lib');
    const fileC = store.insertFile('core/c.ts', 'typescript', 'h', 10, 'core');

    const nodeA1 = store.graph.getNodeId('file', fileA1)!;
    const nodeA2 = store.graph.getNodeId('file', fileA2)!;
    const nodeB = store.graph.getNodeId('file', fileB)!;
    const nodeC = store.graph.getNodeId('file', fileC)!;

    store.graph.ensureEdgeType('imports', 'dependency', 'imports module');
    store.graph.ensureEdgeType('uses', 'usage', 'uses component');

    // app -> lib (2 edges: imports and uses)
    store.graph.insertEdge(nodeA1, nodeB, 'imports', true, undefined, true);
    store.graph.insertEdge(nodeA2, nodeB, 'uses', true, undefined, true);
    // app -> core (1 edge)
    store.graph.insertEdge(nodeA1, nodeC, 'imports', true, undefined, true);
    // same workspace edge marked cross_ws by mistake should be ignored
    store.graph.insertEdge(nodeA1, nodeA2, 'imports', true, undefined, true);

    const graph = store.analytics.getWorkspaceDependencyGraph();
    expect(graph).toHaveLength(2);

    // app -> lib has 2 edges, so it comes first (ORDER BY edge_count DESC)
    expect(graph[0].from_workspace).toBe('app');
    expect(graph[0].to_workspace).toBe('lib');
    expect(graph[0].edge_count).toBe(2);
    const edgeTypes = graph[0].edge_types.split(',');
    expect(edgeTypes.sort()).toEqual(['imports', 'uses']);

    // app -> core has 1 edge
    expect(graph[1].from_workspace).toBe('app');
    expect(graph[1].to_workspace).toBe('core');
    expect(graph[1].edge_count).toBe(1);
    expect(graph[1].edge_types).toBe('imports');
  });

  it('getWorkspaceExports returns distinct symbols in workspace targeted by cross-workspace edges', () => {
    const store = createTestStore();

    const fileClient = store.insertFile('client/index.ts', 'typescript', 'h', 10, 'client');
    const fileServer = store.insertFile('server/api.ts', 'typescript', 'h', 10, 'server');

    const symClient = store.insertSymbol(fileClient, {
      symbolId: 'client/index.ts::run#function',
      name: 'run',
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
    });
    const symApi = store.insertSymbol(fileServer, {
      symbolId: 'server/api.ts::handleRequest#function',
      name: 'handleRequest',
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
    });
    store.insertSymbol(fileServer, {
      symbolId: 'server/api.ts::internalHelper#function',
      name: 'internalHelper',
      kind: 'function',
      byteStart: 11,
      byteEnd: 20,
    });

    const nodeClient = store.graph.getNodeId('symbol', symClient)!;
    const nodeApi = store.graph.getNodeId('symbol', symApi)!;
    store.graph.ensureEdgeType('calls', 'usage', 'calls function');

    // Cross-workspace edge client -> server api
    store.graph.insertEdge(nodeClient, nodeApi, 'calls', true, undefined, true);

    const exports = store.analytics.getWorkspaceExports('server');
    expect(exports).toHaveLength(1);
    expect(exports[0].name).toBe('handleRequest');
    expect(exports[0].file_path).toBe('server/api.ts');

    // No cross-workspace edges into client
    expect(store.analytics.getWorkspaceExports('client')).toHaveLength(0);
  });
});

describe('AnalyticsRepository — index stats', () => {
  it('computes accurate totals for files, symbols, nodes, edges, and status counts', () => {
    const store = createTestStore();

    const file1 = store.insertFile('src/a.ts', 'typescript', 'h1', 50);
    const file2 = store.insertFile('src/b.ts', 'typescript', 'h2', 50);
    const file3 = store.insertFile('src/c.ts', 'typescript', 'h3', 50);

    // Set file statuses
    store.db.prepare("UPDATE files SET status = 'partial' WHERE id = ?").run(file2);
    store.db.prepare("UPDATE files SET status = 'error' WHERE id = ?").run(file3);

    const sym1 = store.insertSymbol(file1, {
      symbolId: 'src/a.ts::A#class',
      name: 'A',
      kind: 'class',
      byteStart: 0,
      byteEnd: 10,
    });
    const sym2 = store.insertSymbol(file1, {
      symbolId: 'src/a.ts::b#function',
      name: 'b',
      kind: 'function',
      byteStart: 11,
      byteEnd: 20,
    });

    store.insertComponent({ name: 'Modal', kind: 'component', framework: 'vue', props: {} }, file1);
    store.insertMigration(
      { tableName: 'users', operation: 'create', timestamp: '2026-01-01' },
      file1,
    );

    const node1 = store.graph.getNodeId('symbol', sym1)!;
    const node2 = store.graph.getNodeId('symbol', sym2)!;
    store.graph.ensureEdgeType('calls', 'usage', 'calls');
    store.graph.insertEdge(node1, node2, 'calls');

    const stats = store.analytics.getStats();
    expect(stats.totalFiles).toBe(3);
    expect(stats.partialFiles).toBe(1);
    expect(stats.errorFiles).toBe(1);
    expect(stats.totalSymbols).toBe(2);
    expect(stats.totalComponents).toBe(1);
    expect(stats.totalMigrations).toBe(1);
    expect(stats.totalEdges).toBe(1);
    // Nodes include 3 files + 2 symbols + 1 component + 1 migration
    expect(stats.totalNodes).toBe(7);
  });
});

describe('AnalyticsRepository — graph snapshots', () => {
  it('inserts and filters graph snapshots by type, file path, and limit', () => {
    const store = createTestStore();

    const id1 = store.analytics.insertGraphSnapshot(
      'file-summary',
      { symbols: 5, complexity: 12 },
      'commit-aaa',
      'src/main.ts',
    );
    const id2 = store.analytics.insertGraphSnapshot(
      'file-summary',
      { symbols: 10, complexity: 25 },
      'commit-bbb',
      'src/other.ts',
    );
    const id3 = store.analytics.insertGraphSnapshot(
      'cluster-summary',
      { clusterCount: 3 },
      'commit-ccc',
    );

    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(id1);
    expect(id3).toBeGreaterThan(id2);

    // Filter by type
    const fileSnapshots = store.analytics.getGraphSnapshots('file-summary');
    expect(fileSnapshots).toHaveLength(2);
    const parsedData = fileSnapshots.map((s) => JSON.parse(s.data));
    expect(parsedData).toEqual(
      expect.arrayContaining([
        { symbols: 5, complexity: 12 },
        { symbols: 10, complexity: 25 },
      ]),
    );

    // Filter with since
    const sinceSnapshots = store.analytics.getGraphSnapshots('file-summary', {
      since: '2020-01-01',
    });
    expect(sinceSnapshots).toHaveLength(2);
    const futureSnapshots = store.analytics.getGraphSnapshots('file-summary', {
      since: '2099-01-01',
    });
    expect(futureSnapshots).toHaveLength(0);

    // Filter by type and filePath
    const mainSnapshots = store.analytics.getGraphSnapshots('file-summary', {
      filePath: 'src/main.ts',
    });
    expect(mainSnapshots).toHaveLength(1);
    expect(mainSnapshots[0].commit_hash).toBe('commit-aaa');
    expect(mainSnapshots[0].file_path).toBe('src/main.ts');

    // Limit option
    const limited = store.analytics.getGraphSnapshots('file-summary', { limit: 1 });
    expect(limited).toHaveLength(1);

    // Non-existent type
    const empty = store.analytics.getGraphSnapshots('non-existent');
    expect(empty).toEqual([]);
  });

  it('prunes snapshots older than maxAge days', () => {
    const store = createTestStore();

    store.analytics.insertGraphSnapshot('old-snapshot', { old: true });
    store.analytics.insertGraphSnapshot('fresh-snapshot', { old: false });

    // Backdate the first snapshot by 100 days
    store.db
      .prepare(
        "UPDATE graph_snapshots SET created_at = datetime('now', '-100 days') WHERE snapshot_type = 'old-snapshot'",
      )
      .run();

    // Pruning with maxAge = 90 days should remove the 100-day-old snapshot and keep the fresh one
    const deletedCount = store.analytics.pruneGraphSnapshots(90);
    expect(deletedCount).toBe(1);

    const oldRows = store.analytics.getGraphSnapshots('old-snapshot');
    expect(oldRows).toHaveLength(0);

    const freshRows = store.analytics.getGraphSnapshots('fresh-snapshot');
    expect(freshRows).toHaveLength(1);
  });
});
