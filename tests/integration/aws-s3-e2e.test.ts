/**
 * AWS S3 E2E integration test.
 * Asserts file → framework_role mapping and verifies that resolveEdges emits
 * s3_access edges with bucket/op/api metadata across v2 and v3 usage.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { AwsS3Plugin } from '../../src/indexer/plugins/integration/tooling/aws-s3/index.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/aws-s3-app');

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
  'src/client.ts': 's3_client',
  'src/v3-commands.ts': 's3_usage',
  'src/v3-upload.ts': 's3_upload',
  'src/v2-api.ts': 's3_client', // constructs `new AWS.S3(...)` — client role wins
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

describe('AWS S3 E2E', () => {
  let store: Store;
  let fileByRel: Map<string, { framework_role: string | null }>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new AwsS3Plugin());

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
  });

  describe('edges — v3 commands', () => {
    it('emits read edge for GetObjectCommand', () => {
      const edges = loadEdges(store, 's3_access').filter((e) => e.meta.kind === 'GetObjectCommand');
      expect(edges).toHaveLength(1);
      expect(edges[0].meta.op).toBe('read');
      expect(edges[0].meta.api).toBe('v3');
      expect(edges[0].meta.bucket).toBe('avatars');
      expect(edges[0].srcSymbolId).toBe('src/v3-commands.ts::readAvatar#function');
    });

    it('emits write edge for PutObjectCommand', () => {
      const edges = loadEdges(store, 's3_access').filter((e) => e.meta.kind === 'PutObjectCommand');
      expect(edges).toHaveLength(1);
      expect(edges[0].meta.op).toBe('write');
      expect(edges[0].meta.bucket).toBe('avatars');
      expect(edges[0].srcSymbolId).toBe('src/v3-commands.ts::writeAvatar#function');
    });

    it('emits delete edge for DeleteObjectCommand', () => {
      const edges = loadEdges(store, 's3_access').filter((e) => e.meta.kind === 'DeleteObjectCommand');
      expect(edges).toHaveLength(1);
      expect(edges[0].meta.op).toBe('delete');
      expect(edges[0].meta.bucket).toBe('avatars');
    });

    it('emits list edge for ListObjectsV2Command with a different bucket', () => {
      const edges = loadEdges(store, 's3_access').filter((e) => e.meta.kind === 'ListObjectsV2Command');
      expect(edges).toHaveLength(1);
      expect(edges[0].meta.op).toBe('list');
      expect(edges[0].meta.bucket).toBe('logs');
    });
  });

  describe('edges — lib-storage Upload', () => {
    it('emits write edge for new Upload({ params: { Bucket } })', () => {
      const edges = loadEdges(store, 's3_access').filter((e) => e.meta.kind === 'Upload');
      expect(edges).toHaveLength(1);
      expect(edges[0].meta.op).toBe('write');
      expect(edges[0].meta.api).toBe('v3');
      expect(edges[0].meta.bucket).toBe('backups');
      expect(edges[0].srcSymbolId).toBe('src/v3-upload.ts::streamToBackups#function');
    });
  });

  describe('edges — v2 API', () => {
    it('emits read/write/delete edges for v2 method calls', () => {
      const edges = loadEdges(store, 's3_access').filter((e) => e.meta.api === 'v2');
      const ops = edges.map((e) => e.meta.op).sort();
      expect(ops).toEqual(['delete', 'read', 'write']);
      for (const e of edges) expect(e.meta.bucket).toBe('reports');
    });
  });

  it('does not emit edges for non-literal Bucket values (none present in fixture)', () => {
    const edges = loadEdges(store, 's3_access');
    for (const e of edges) {
      expect(typeof e.meta.bucket).toBe('string');
      expect(e.meta.bucket).not.toContain('${');
    }
  });
});
