/**
 * ioredis E2E integration test.
 * Asserts strict file → framework_role mapping, and verifies that resolveEdges
 * emits symbol-level edges with correct metadata for channels/streams/queues.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { IoredisPlugin } from '../../src/indexer/plugins/integration/tooling/ioredis/index.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/ioredis-app');

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
  'src/client.ts': 'redis_client',
  'src/cache.ts': 'redis_usage',
  'src/pubsub.ts': 'redis_pubsub',
  'src/stream.ts': 'redis_stream',
  'src/queue.ts': 'redis_queue',
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
      const s = store.db
        .prepare('SELECT symbol_id FROM symbols WHERE id = ?')
        .get(node.ref_id) as { symbol_id: string } | undefined;
      if (s) srcSymbolId = s.symbol_id;
    }
    return { meta, srcSymbolId };
  });
}

describe('ioredis E2E', () => {
  let store: Store;
  let fileByRel: Map<string, { framework_role: string | null }>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new IoredisPlugin());

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

    it.each(Object.entries(EXPECTED_ROLES))(
      'tags %s with role %s',
      (rel, expectedRole) => {
        const file = fileByRel.get(rel);
        expect(file, `missing ${rel}`).toBeDefined();
        expect(file!.framework_role).toBe(expectedRole);
      },
    );

    it('detects usage without direct ioredis import (shared-client pattern)', () => {
      expect(fileByRel.get('src/cache.ts')!.framework_role).toBe('redis_usage');
      expect(fileByRel.get('src/stream.ts')!.framework_role).toBe('redis_stream');
    });
  });

  describe('edges', () => {
    it('emits redis_pubsub edges for publish and subscribe', () => {
      const edges = loadEdges(store, 'redis_pubsub');
      const ops = edges.map((e) => e.meta.op).sort();
      expect(ops).toEqual(['publish', 'subscribe']);
      for (const e of edges) {
        expect(e.meta.channel).toBe('events');
        expect(e.meta.file).toBe('src/pubsub.ts');
        expect(typeof e.meta.line).toBe('number');
      }
    });

    it('attributes publish edge to the broadcast function', () => {
      const edges = loadEdges(store, 'redis_pubsub');
      const publish = edges.find((e) => e.meta.op === 'publish');
      expect(publish?.srcSymbolId).toBe('src/pubsub.ts::broadcast#function');
    });

    it('emits redis_stream edge with correct stream name and enclosing symbol', () => {
      const edges = loadEdges(store, 'redis_stream');
      expect(edges).toHaveLength(1);
      expect(edges[0].meta.stream).toBe('events-stream');
      expect(edges[0].meta.op).toBe('xadd');
      expect(edges[0].srcSymbolId).toBe('src/stream.ts::appendEvent#function');
    });

    it('emits redis_queue edges for Queue and Worker with matching names', () => {
      const edges = loadEdges(store, 'redis_queue');
      expect(edges).toHaveLength(2);
      const ops = edges.map((e) => e.meta.op).sort();
      expect(ops).toEqual(['queue', 'worker']);
      for (const e of edges) expect(e.meta.queue).toBe('email');
      const symbolIds = edges.map((e) => e.srcSymbolId).sort();
      expect(symbolIds).toEqual([
        'src/queue.ts::emailQueue#variable',
        'src/queue.ts::emailWorker#variable',
      ]);
    });
  });
});
