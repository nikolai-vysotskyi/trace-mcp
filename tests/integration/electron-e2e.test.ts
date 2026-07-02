/**
 * Electron E2E integration test.
 *
 * Regression guard for the bug where the Electron plugin emitted edges as
 * `{ source: filePath, target: <channel> }` — fields that do not exist on
 * `RawEdge`. The edge resolver drops any edge lacking a resolvable source
 * (sourceSymbolId or sourceNodeType+sourceRefId), so EVERY electron edge was
 * silently discarded and an indexed electron fixture produced 0 edges.
 *
 * This test indexes the real electron-app fixture through the full
 * IndexingPipeline and asserts that electron_* edge rows actually land in the
 * DB, with resolver-recognized source (symbol or file node) and virtual
 * `electron-channel::<name>` targets.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { ElectronPlugin } from '../../src/indexer/plugins/integration/tooling/electron/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/electron-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

interface StoredEdge {
  edgeType: string;
  meta: Record<string, unknown>;
  srcNodeType: string | null;
  tgtNodeType: string | null;
  tgtSymbolId: string | null;
}

function loadElectronEdges(store: Store): StoredEdge[] {
  const rows = store.db
    .prepare(`
      SELECT et.name AS edge_type,
             e.metadata AS metadata,
             sn.node_type AS src_node_type,
             tn.node_type AS tgt_node_type,
             ts.symbol_id AS tgt_symbol_id
      FROM edges e
      JOIN edge_types et ON et.id = e.edge_type_id
      JOIN nodes sn ON sn.id = e.source_node_id
      JOIN nodes tn ON tn.id = e.target_node_id
      LEFT JOIN symbols ts ON tn.node_type = 'symbol' AND tn.ref_id = ts.id
      WHERE et.name LIKE 'electron_%'
    `)
    .all() as Array<{
    edge_type: string;
    metadata: string | null;
    src_node_type: string | null;
    tgt_node_type: string | null;
    tgt_symbol_id: string | null;
  }>;
  return rows.map((r) => ({
    edgeType: r.edge_type,
    meta: r.metadata ? JSON.parse(r.metadata) : {},
    srcNodeType: r.src_node_type,
    tgtNodeType: r.tgt_node_type,
    tgtSymbolId: r.tgt_symbol_id,
  }));
}

describe('Electron E2E', () => {
  let store: Store;
  let edges: StoredEdge[];

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new ElectronPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();

    edges = loadElectronEdges(store);
  });

  it('persists at least one electron_* edge (regression: was 0)', () => {
    // The core assertion. Before the fix this was 0 because every emitted edge
    // used {source, target} which the resolver could not map to graph nodes.
    expect(edges.length).toBeGreaterThan(0);
  });

  it('persists ipcMain.handle edges with the channel in metadata', () => {
    const handleEdges = edges.filter((e) => e.edgeType === 'electron_ipc_handle');
    expect(handleEdges.length).toBeGreaterThan(0);
    // The channel identity lives in metadata. The virtual `electron-channel::`
    // target has no backing symbol, so the resolver stores these as self-loops
    // (target node === source node), mirroring the s3-bucket:: precedent.
    for (const e of handleEdges) {
      expect(typeof e.meta.channel).toBe('string');
    }
    expect(handleEdges.map((e) => e.meta.channel)).toContain('select-folder');
  });

  it('anchors every edge on a resolver-recognized source node', () => {
    for (const e of edges) {
      // Module-scope calls attribute to the file's TS module symbol; calls inside
      // a function attribute to that function; a file with no symbol table falls
      // back to the file node. Every case is resolver-recognized.
      expect(['symbol', 'file']).toContain(e.srcNodeType);
    }
  });

  it('resolves cross-file renderer invoke → main handler file', () => {
    const invoke = edges.filter(
      (e) => e.edgeType === 'electron_ipc_invoke' && e.meta.resolution === 'cross_file',
    );
    expect(invoke.length).toBeGreaterThan(0);
    // Cross-file IPC edges carry a real target FILE node (not a self-loop), so
    // every distinct channel→handler mapping survives INSERT OR IGNORE.
    for (const e of invoke) {
      expect(e.tgtNodeType).toBe('file');
      expect(e.meta.targetFile).toBe('src/main/index.ts');
    }
    // renderer/api.ts anchors each invoke on a distinct exported function, so
    // both select-folder and open-file resolve as separate edges.
    const channels = invoke
      .filter((e) => e.meta.file === 'src/renderer/api.ts')
      .map((e) => e.meta.channel)
      .sort();
    expect(channels).toEqual(['open-file', 'select-folder']);
  });

  it('persists protocol.handle edge with the scheme in metadata', () => {
    const proto = edges.filter((e) => e.edgeType === 'electron_protocol_handle');
    expect(proto).toHaveLength(1);
    expect(proto[0].meta.scheme).toBe('app');
    // Self-loop: the virtual electron-protocol:: target has no backing symbol.
    expect(proto[0].srcNodeType).toBe('symbol');
  });
});
