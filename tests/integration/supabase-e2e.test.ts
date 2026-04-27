/**
 * Supabase E2E integration test.
 * Asserts file → framework_role mapping and verifies that resolveEdges emits
 * supabase_query / supabase_rpc / supabase_storage / supabase_realtime edges
 * with the expected table/bucket/channel metadata and enclosing symbols.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { SupabasePlugin } from '../../src/indexer/plugins/integration/tooling/supabase/index.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/supabase-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

const EXPECTED_ROLES: Record<string, string> = {
  'src/client.ts': 'supabase_client',
  'src/queries.ts': 'supabase_query',
  'src/storage.ts': 'supabase_storage',
  'src/realtime.ts': 'supabase_realtime',
  'src/auth.ts': 'supabase_auth',
};

interface EdgeWithMeta {
  meta: Record<string, unknown>;
  srcSymbolId: string | null;
}

function loadEdges(store: Store, edgeType: string): EdgeWithMeta[] {
  const edges = store.getEdgesByType(edgeType);
  return edges.map((e) => {
    const meta = e.metadata ? JSON.parse(e.metadata) : {};
    const node = store.db
      .prepare('SELECT node_type, ref_id FROM nodes WHERE id = ?')
      .get(e.source_node_id) as { node_type: string; ref_id: number } | undefined;
    let srcSymbolId: string | null = null;
    if (node?.node_type === 'symbol') {
      const s = store.db.prepare('SELECT symbol_id FROM symbols WHERE id = ?').get(node.ref_id) as
        | { symbol_id: string }
        | undefined;
      if (s) srcSymbolId = s.symbol_id;
    }
    return { meta, srcSymbolId };
  });
}

describe('Supabase E2E', () => {
  let store: Store;
  let fileByRel: Map<string, { framework_role: string | null }>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new SupabasePlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();

    fileByRel = new Map();
    for (const f of store.getAllFiles()) {
      fileByRel.set(f.path.replace(/\\/g, '/'), f);
    }
  });

  describe('framework roles', () => {
    it('indexes every fixture file', () => {
      for (const rel of Object.keys(EXPECTED_ROLES)) {
        expect(fileByRel.has(rel), `missing ${rel}`).toBe(true);
      }
    });

    it.each(Object.entries(EXPECTED_ROLES))('tags %s with role %s', (rel, expectedRole) => {
      const file = fileByRel.get(rel);
      expect(file, `missing ${rel}`).toBeDefined();
      expect(file!.framework_role).toBe(expectedRole);
    });
  });

  describe('edges — queries', () => {
    it('emits supabase_query edges with correct table and op for each CRUD operation', () => {
      const edges = loadEdges(store, 'supabase_query');
      const byOp = new Map<string, EdgeWithMeta>();
      for (const e of edges) byOp.set(e.meta.op as string, e);

      expect(byOp.get('select')?.meta.table).toBe('users');
      expect(byOp.get('select')?.srcSymbolId).toBe('src/queries.ts::listUsers#function');

      expect(byOp.get('insert')?.meta.table).toBe('users');
      expect(byOp.get('insert')?.srcSymbolId).toBe('src/queries.ts::createUser#function');

      expect(byOp.get('update')?.meta.table).toBe('posts');
      expect(byOp.get('update')?.srcSymbolId).toBe('src/queries.ts::touchPost#function');

      expect(byOp.get('delete')?.meta.table).toBe('posts');
      expect(byOp.get('delete')?.srcSymbolId).toBe('src/queries.ts::removePost#function');

      expect(byOp.get('upsert')?.meta.table).toBe('tags');
      expect(byOp.get('upsert')?.srcSymbolId).toBe('src/queries.ts::upsertTag#function');
    });

    it('covers each of the five CRUD ops exactly once', () => {
      const edges = loadEdges(store, 'supabase_query');
      const ops = edges.map((e) => e.meta.op).sort();
      expect(ops).toEqual(['delete', 'insert', 'select', 'update', 'upsert']);
    });
  });

  describe('edges — RPC', () => {
    it('emits supabase_rpc edge with procedure name', () => {
      const edges = loadEdges(store, 'supabase_rpc');
      expect(edges).toHaveLength(1);
      expect(edges[0].meta.procedure).toBe('count_active_users');
      expect(edges[0].meta.op).toBe('rpc');
      expect(edges[0].srcSymbolId).toBe('src/queries.ts::countActive#function');
    });
  });

  describe('edges — storage', () => {
    it('emits supabase_storage edges with bucket, op, and enclosing symbol', () => {
      const edges = loadEdges(store, 'supabase_storage');
      const byOp = new Map<string, EdgeWithMeta>();
      for (const e of edges) byOp.set(e.meta.op as string, e);

      expect(byOp.get('upload')?.meta.bucket).toBe('avatars');
      expect(byOp.get('upload')?.srcSymbolId).toBe('src/storage.ts::uploadAvatar#function');

      expect(byOp.get('remove')?.meta.bucket).toBe('avatars');
      expect(byOp.get('remove')?.srcSymbolId).toBe('src/storage.ts::removeAvatar#function');

      expect(byOp.get('list')?.meta.bucket).toBe('backups');
      expect(byOp.get('list')?.srcSymbolId).toBe('src/storage.ts::listBackups#function');
    });
  });

  describe('edges — realtime', () => {
    it('emits supabase_realtime edge for .channel(name)', () => {
      const edges = loadEdges(store, 'supabase_realtime');
      expect(edges).toHaveLength(1);
      expect(edges[0].meta.channel).toBe('posts-changes');
      expect(edges[0].meta.op).toBe('subscribe');
      expect(edges[0].srcSymbolId).toBe('src/realtime.ts::subscribePosts#function');
    });
  });
});
