/**
 * redis-py E2E integration test.
 * Indexes the redis-py-app fixture and asserts strict file → framework_role mapping
 * (sync + async), plus symbol-level pub/sub and stream edges with correct metadata.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';
import { RedisPyPlugin } from '../../src/indexer/plugins/integration/tooling/redis-py/index.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/redis-py-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['**/*.py'],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
  };
}

const EXPECTED_ROLES: Record<string, string> = {
  'client.py': 'redis_client',
  'async_client.py': 'redis_client',
  'aliased.py': 'redis_client',
  'cache.py': 'redis_usage',
  'pubsub.py': 'redis_pubsub',
  'stream.py': 'redis_stream',
};

interface EdgeWithMeta {
  meta: Record<string, unknown>;
  srcSymbolId: string | null;
}

function loadEdges(store: Store, edgeType: string): EdgeWithMeta[] {
  return store.getEdgesByType(edgeType).map((e) => {
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

describe('redis-py E2E', () => {
  let store: Store;
  let fileByRel: Map<string, { framework_role: string | null }>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    registry.registerFrameworkPlugin(new RedisPyPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();

    fileByRel = new Map();
    for (const f of store.getAllFiles()) {
      fileByRel.set(f.path.replace(/\\/g, '/'), f);
    }
  });

  describe('framework roles', () => {
    it.each(Object.entries(EXPECTED_ROLES))('tags %s with role %s', (rel, expectedRole) => {
      const file = fileByRel.get(rel);
      expect(file, `missing ${rel}`).toBeDefined();
      expect(file!.framework_role).toBe(expectedRole);
    });

    it('detects async redis client (redis.asyncio.Redis) with multi-line from-import', () => {
      // async_client.py uses parenthesized multi-line `from redis.asyncio import (Redis, ConnectionPool)`.
      // Regression: previously FROM_REDIS_CLASS_RE only captured single-line imports.
      expect(fileByRel.get('async_client.py')!.framework_role).toBe('redis_client');
    });

    it('detects aliased module import (import redis as r; r.Redis())', () => {
      // Regression: previously QUALIFIED_CONNECTION_RE required literal `redis.Redis(`,
      // which missed aliased usage.
      expect(fileByRel.get('aliased.py')!.framework_role).toBe('redis_client');
    });

    it('detects shared-client usage (cache.py imports from ./client, no direct redis import)', () => {
      expect(fileByRel.get('cache.py')!.framework_role).toBe('redis_usage');
    });
  });

  describe('edges', () => {
    it('emits redis_pubsub edges for both publish and subscribe', () => {
      const edges = loadEdges(store, 'redis_pubsub');
      const ops = edges.map((e) => e.meta.op).sort();
      expect(ops).toEqual(['publish', 'subscribe']);
      for (const e of edges) {
        expect(e.meta.channel).toBe('events');
        expect(e.meta.file).toBe('pubsub.py');
      }
    });

    it('attributes publish edge to broadcast() and subscribe edge to listen()', () => {
      const edges = loadEdges(store, 'redis_pubsub');
      const publish = edges.find((e) => e.meta.op === 'publish');
      const subscribe = edges.find((e) => e.meta.op === 'subscribe');
      expect(publish?.srcSymbolId).toBe('pubsub.py::broadcast#function');
      expect(subscribe?.srcSymbolId).toBe('pubsub.py::listen#function');
    });

    it('emits redis_stream edge with correct stream name and enclosing symbol', () => {
      const edges = loadEdges(store, 'redis_stream');
      expect(edges).toHaveLength(1);
      expect(edges[0].meta.stream).toBe('events-stream');
      expect(edges[0].meta.op).toBe('xadd');
      expect(edges[0].srcSymbolId).toBe('stream.py::append_event#function');
    });
  });
});
