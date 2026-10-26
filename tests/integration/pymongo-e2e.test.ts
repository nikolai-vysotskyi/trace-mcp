/**
 * PyMongo plugin E2E integration test.
 *
 * Verifies:
 * - Framework detection and roles (pymongo_client, pymongo_usage)
 * - Literal collection extraction: db["name"], db.get_collection("name"), client["db"]["name"], local wrapper helper
 * - Operation classification:
 *     read: find, find_one, aggregate, count_documents, distinct
 *     write: insert_*, update_*, replace_one, delete_*, bulk_write, find_one_and_*
 * - Accurate function -> collection edges with line and op metadata
 * - Cross-file usages via findReferences (find_usages) and getChangeImpact (get_change_impact)
 * - Negative tests: dynamic collection names, unrelated dictionaries, string .find(), no credential leaks
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PyMongoPlugin } from '../../src/indexer/plugins/integration/orm/pymongo/index.js';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { getChangeImpact } from '../../src/tools/analysis/impact.js';
import { findReferences } from '../../src/tools/framework/references.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/pymongo-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['**/*.py'],
    exclude: [],
    plugins: [],
  };
}

interface EdgeWithMeta {
  edgeType: string;
  sourceSymbolId: string | null;
  targetSymbolId: string | null;
  meta: Record<string, unknown>;
}

function loadAllEdges(store: Store): EdgeWithMeta[] {
  const edgeTypeRows = store.db.prepare('SELECT id, name FROM edge_types').all() as {
    id: number;
    name: string;
  }[];
  const typeMap = new Map(edgeTypeRows.map((r) => [r.id, r.name]));

  const edges = store.db
    .prepare('SELECT source_node_id, target_node_id, edge_type_id, metadata FROM edges')
    .all() as {
    source_node_id: number;
    target_node_id: number;
    edge_type_id: number;
    metadata: string | null;
  }[];

  return edges.map((e) => {
    const meta = e.metadata ? JSON.parse(e.metadata) : {};
    const srcNode = store.db
      .prepare('SELECT node_type, ref_id FROM nodes WHERE id = ?')
      .get(e.source_node_id) as { node_type: string; ref_id: number } | undefined;
    const tgtNode = store.db
      .prepare('SELECT node_type, ref_id FROM nodes WHERE id = ?')
      .get(e.target_node_id) as { node_type: string; ref_id: number } | undefined;

    let sourceSymbolId: string | null = null;
    if (srcNode?.node_type === 'symbol') {
      const s = store.db
        .prepare('SELECT symbol_id FROM symbols WHERE id = ?')
        .get(srcNode.ref_id) as { symbol_id: string } | undefined;
      if (s) sourceSymbolId = s.symbol_id;
    }

    let targetSymbolId: string | null = null;
    if (tgtNode?.node_type === 'symbol') {
      const s = store.db
        .prepare('SELECT symbol_id FROM symbols WHERE id = ?')
        .get(tgtNode.ref_id) as { symbol_id: string } | undefined;
      if (s) targetSymbolId = s.symbol_id;
    }

    return {
      edgeType: typeMap.get(e.edge_type_id) ?? 'unknown',
      sourceSymbolId,
      targetSymbolId,
      meta,
    };
  });
}

describe('pymongo plugin E2E', () => {
  let store: Store;
  let fileByRel: Map<string, { framework_role: string | null }>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    registry.registerFrameworkPlugin(new PyMongoPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();

    fileByRel = new Map();
    for (const f of store.getAllFiles()) {
      fileByRel.set(f.path.replace(/\\/g, '/'), f);
    }
  });

  describe('framework detection and roles', () => {
    it('detects pymongo and tags client file with pymongo_client', () => {
      const dbFile = fileByRel.get('db.py');
      expect(dbFile).toBeDefined();
      expect(dbFile!.framework_role).toBe('pymongo_client');
    });

    it('tags usage files with pymongo_usage', () => {
      const readers = fileByRel.get('readers.py');
      const writers = fileByRel.get('writers.py');
      expect(readers).toBeDefined();
      expect(readers!.framework_role).toBe('pymongo_usage');
      expect(writers).toBeDefined();
      expect(writers!.framework_role).toBe('pymongo_usage');
    });
  });

  describe('collection nodes and symbols', () => {
    it('creates symbols for all literal collections', () => {
      const expectedCollections = [
        'collection:orders',
        'collection:reports',
        'collection:events',
        'collection:metrics',
        'collection:categories',
        'collection:audit_logs',
        'collection:sessions',
      ];

      for (const collSymId of expectedCollections) {
        const sym = store.getSymbolBySymbolId(collSymId);
        expect(sym, `missing symbol ${collSymId}`).toBeDefined();
        expect(sym!.kind).toBe('variable');
        expect(sym!.fqn).toBe(collSymId);
      }
    });

    it('does NOT create collection symbols for dynamic names or dict keys', () => {
      const badSymbols = [
        'collection:col_name',
        'collection:dynamic_table',
        'collection:runtime_name',
        'collection:users',
        'collection:needle',
      ];
      for (const bad of badSymbols) {
        const sym = store.getSymbolBySymbolId(bad);
        expect(sym, `unexpected symbol created: ${bad}`).toBeUndefined();
      }
    });
  });

  describe('read/write operation classification and edges', () => {
    it('emits pymongo_reads edges for find, find_one, aggregate, count_documents, distinct', () => {
      const allEdges = loadAllEdges(store);
      const readEdges = allEdges.filter((e) => e.edgeType === 'pymongo_reads');
      expect(readEdges.length).toBeGreaterThanOrEqual(5);

      const findEdge = readEdges.find(
        (e) => e.targetSymbolId === 'collection:orders' && e.meta.method === 'find',
      );
      expect(findEdge).toBeDefined();
      expect(findEdge!.sourceSymbolId).toBe('readers.py::read_orders_find#function');
      expect(findEdge!.meta.op).toBe('read');
      expect(findEdge!.meta.collection).toBe('orders');

      const findOneEdge = readEdges.find(
        (e) => e.targetSymbolId === 'collection:reports' && e.meta.method === 'find_one',
      );
      expect(findOneEdge).toBeDefined();
      expect(findOneEdge!.sourceSymbolId).toBe('readers.py::read_reports_find_one#function');

      const aggEdge = readEdges.find(
        (e) => e.targetSymbolId === 'collection:events' && e.meta.method === 'aggregate',
      );
      expect(aggEdge).toBeDefined();
      expect(aggEdge!.sourceSymbolId).toBe('readers.py::read_events_aggregate#function');

      const countEdge = readEdges.find(
        (e) => e.targetSymbolId === 'collection:metrics' && e.meta.method === 'count_documents',
      );
      expect(countEdge).toBeDefined();
      expect(countEdge!.sourceSymbolId).toBe('readers.py::read_metrics_count#function');

      const distinctEdge = readEdges.find(
        (e) => e.targetSymbolId === 'collection:categories' && e.meta.method === 'distinct',
      );
      expect(distinctEdge).toBeDefined();
      expect(distinctEdge!.sourceSymbolId).toBe('readers.py::read_categories_distinct#function');
    });

    it('emits pymongo_writes edges for insert_*, update_*, replace_one, delete_*, bulk_write, find_one_and_*', () => {
      const allEdges = loadAllEdges(store);
      const writeEdges = allEdges.filter((e) => e.edgeType === 'pymongo_writes');
      expect(writeEdges.length).toBeGreaterThanOrEqual(6);

      const insertEdge = writeEdges.find((e) => e.targetSymbolId === 'collection:orders');
      expect(insertEdge).toBeDefined();
      expect(insertEdge!.sourceSymbolId).toBe('writers.py::write_orders_insert#function');
      expect(insertEdge!.meta.op).toBe('write');

      const updateEdge = writeEdges.find((e) => e.targetSymbolId === 'collection:reports');
      expect(updateEdge).toBeDefined();
      expect(updateEdge!.sourceSymbolId).toBe('writers.py::write_reports_update#function');

      const replaceEdge = writeEdges.find(
        (e) => e.targetSymbolId === 'collection:events' && e.meta.method === 'replace_one',
      );
      expect(replaceEdge).toBeDefined();
      expect(replaceEdge!.sourceSymbolId).toBe('writers.py::write_events_replace#function');

      const deleteEdge = writeEdges.find((e) => e.targetSymbolId === 'collection:metrics');
      expect(deleteEdge).toBeDefined();
      expect(deleteEdge!.sourceSymbolId).toBe('writers.py::write_metrics_delete#function');

      const bulkEdge = writeEdges.find(
        (e) => e.targetSymbolId === 'collection:audit_logs' && e.meta.method === 'bulk_write',
      );
      expect(bulkEdge).toBeDefined();
      expect(bulkEdge!.sourceSymbolId).toBe('writers.py::write_audit_bulk#function');

      const findAndModifyEdge = writeEdges.find((e) => e.targetSymbolId === 'collection:sessions');
      expect(findAndModifyEdge).toBeDefined();
      expect(findAndModifyEdge!.sourceSymbolId).toBe(
        'writers.py::write_sessions_find_and_modify#function',
      );
    });
  });

  describe('find_usages and get_change_impact integration', () => {
    it('findReferences on collection:orders finds both reader and writer functions across files', () => {
      const result = findReferences(store, { symbolId: 'collection:orders' });
      expect(result.isOk()).toBe(true);
      const refs = result._unsafeUnwrap();
      expect(refs.total).toBe(2);

      const srcSymbols = refs.references.map((r) => r.symbol?.symbol_id).sort();
      expect(srcSymbols).toEqual([
        'readers.py::read_orders_find#function',
        'writers.py::write_orders_insert#function',
      ]);

      const files = [...new Set(refs.references.map((r) => r.file))].sort();
      expect(files).toEqual(['readers.py', 'writers.py']);
    });

    it('findReferences resolves by fqn and bare collection name', () => {
      const byFqn = findReferences(store, { fqn: 'collection:orders' });
      expect(byFqn.isOk()).toBe(true);
      expect(byFqn._unsafeUnwrap().total).toBe(2);

      const byBareName = findReferences(store, { symbolId: 'orders' });
      expect(byBareName.isOk()).toBe(true);
      expect(byBareName._unsafeUnwrap().total).toBe(2);
    });

    it('getChangeImpact on collection:orders returns dependents across readers.py and writers.py', () => {
      const result = getChangeImpact(store, { symbolId: 'collection:orders' });
      expect(result.isOk()).toBe(true);
      const impact = result._unsafeUnwrap();

      expect(impact.target.symbolId).toBe('collection:orders');
      const affectedFiles = impact.dependents.map((d) => d.path).sort();
      expect(affectedFiles).toContain('readers.py');
      expect(affectedFiles).toContain('writers.py');
      expect(impact.totalAffected).toBeGreaterThanOrEqual(2);
    });
  });

  describe('negative tests and credential safety', () => {
    it('does not emit any pymongo edges from negative.py', () => {
      const allEdges = loadAllEdges(store);
      const negativeEdges = allEdges.filter(
        (e) =>
          (e.edgeType === 'pymongo_reads' || e.edgeType === 'pymongo_writes') &&
          e.sourceSymbolId?.startsWith('negative.py'),
      );
      expect(negativeEdges).toHaveLength(0);
    });

    it('does not store Mongo URI or credentials in metadata, symbols, or edges', () => {
      const allEdges = loadAllEdges(store);
      const allSymbols = store.db.prepare('SELECT metadata FROM symbols').all() as {
        metadata: string | null;
      }[];

      for (const e of allEdges) {
        const metaStr = JSON.stringify(e.meta);
        expect(metaStr).not.toMatch(/mongodb(?:\+srv)?:\/\//);
        expect(metaStr).not.toMatch(/password|secret|credential/i);
      }

      for (const s of allSymbols) {
        const metaStr = JSON.stringify(s.metadata ? JSON.parse(s.metadata) : {});
        expect(metaStr).not.toMatch(/mongodb(?:\+srv)?:\/\//);
        expect(metaStr).not.toMatch(/password|secret|credential/i);
      }
    });
  });
});
