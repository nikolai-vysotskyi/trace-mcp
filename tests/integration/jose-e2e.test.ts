/**
 * jose E2E integration test.
 * Asserts strict file → framework_role mapping for jose + jsonwebtoken (qualified + destructured),
 * and verifies that resolveEdges emits JWKS/issuer edges at symbol granularity.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { JosePlugin } from '../../src/indexer/plugins/integration/tooling/jose/index.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/jose-app');

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
  'src/signer.ts': 'jwt_signer',
  'src/verifier.ts': 'jwt_verifier',
  'src/keys.ts': 'jwt_keys',
  'src/legacy.ts': 'jwt_auth',
  'src/legacy-qualified.ts': 'jwt_auth',
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

describe('jose E2E', () => {
  let store: Store;
  let fileByRel: Map<string, { framework_role: string | null }>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new JosePlugin());

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

    it('catches jsonwebtoken destructured imports (unqualified sign/verify)', () => {
      expect(fileByRel.get('src/legacy.ts')!.framework_role).toBe('jwt_auth');
    });
  });

  describe('edges', () => {
    it('emits jwk_imports edge with correct URL for createRemoteJWKSet', () => {
      const edges = loadEdges(store, 'jwk_imports');
      expect(edges).toHaveLength(1);
      expect(edges[0].meta.url).toBe('https://example.com/.well-known/jwks.json');
      expect(edges[0].meta.file).toBe('src/verifier.ts');
    });

    it('emits jwt_verifies edge with issuer and audiences', () => {
      const edges = loadEdges(store, 'jwt_verifies');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      const verifier = edges.find((e) => e.meta.file === 'src/verifier.ts');
      expect(verifier).toBeDefined();
      expect(verifier!.meta.issuer).toBe('https://example.com');
      expect(verifier!.meta.audiences).toEqual(['my-api']);
      expect(verifier!.srcSymbolId).toBe('src/verifier.ts::verifyAccessToken#function');
    });

    it('does not emit issuer edges from non-verifying files', () => {
      const edges = loadEdges(store, 'jwt_verifies');
      const sourceFiles = edges.map((e) => e.meta.file);
      expect(sourceFiles).not.toContain('src/signer.ts');
      expect(sourceFiles).not.toContain('src/keys.ts');
    });
  });
});
