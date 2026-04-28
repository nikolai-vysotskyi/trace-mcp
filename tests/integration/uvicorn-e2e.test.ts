/**
 * uvicorn E2E integration test.
 * Indexes the uvicorn-app fixture and asserts file → framework_role mapping plus
 * symbol-level asgi_server_runs edges (covering `uvicorn.run(app)`, string form,
 * and `from uvicorn import run; run(app)`).
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { UvicornPlugin } from '../../src/indexer/plugins/integration/tooling/uvicorn/index.js';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/uvicorn-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['**/*.py'],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
  };
}

const EXPECTED_ROLES: Record<string, string | null> = {
  'main.py': 'asgi_server',
  'dev.py': 'asgi_server',
  'alt_entry.py': 'asgi_server',
  'app.py': null,
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

describe('uvicorn E2E', () => {
  let store: Store;
  let fileByRel: Map<string, { framework_role: string | null }>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    registry.registerFrameworkPlugin(new UvicornPlugin());

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
  });

  describe('edges', () => {
    it('emits asgi_server_runs edges for every uvicorn.run call style', () => {
      const edges = loadEdges(store, 'asgi_server_runs');
      expect(edges).toHaveLength(3);
    });

    it('captures uvicorn.run(app) with identifier app', () => {
      const edges = loadEdges(store, 'asgi_server_runs');
      const main = edges.find((e) => e.meta.file === 'main.py');
      expect(main).toBeDefined();
      expect(main!.meta.app).toBe('app');
      expect(main!.srcSymbolId).toBe('main.py::main#function');
    });

    it('captures uvicorn.run("module:app") string form', () => {
      const edges = loadEdges(store, 'asgi_server_runs');
      const dev = edges.find((e) => e.meta.file === 'dev.py');
      expect(dev).toBeDefined();
      expect(dev!.meta.app).toBe('app:app');
      expect(dev!.srcSymbolId).toBe('dev.py::dev#function');
    });

    it('captures `from uvicorn import run; run(app)` unqualified form', () => {
      const edges = loadEdges(store, 'asgi_server_runs');
      const alt = edges.find((e) => e.meta.file === 'alt_entry.py');
      expect(alt).toBeDefined();
      expect(alt!.meta.app).toBe('wsgi');
      expect(alt!.srcSymbolId).toBe('alt_entry.py::serve#function');
    });
  });
});
