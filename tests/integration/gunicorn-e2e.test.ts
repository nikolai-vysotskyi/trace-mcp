/**
 * gunicorn E2E integration test.
 * Indexes the gunicorn-app fixture and asserts file → framework_role mapping plus
 * a wsgi_server_runs edge emitted from gunicorn.conf.py with bind / workers / worker_class metadata.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';
import { GunicornPlugin } from '../../src/indexer/plugins/integration/tooling/gunicorn/index.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/gunicorn-app');

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
  'gunicorn.conf.py': 'wsgi_server_config',
  'custom_app.py': 'wsgi_server_custom',
  'wsgi.py': null,
};

describe('gunicorn E2E', () => {
  let store: Store;
  let fileByRel: Map<string, { framework_role: string | null }>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    registry.registerFrameworkPlugin(new GunicornPlugin());

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
    it('emits exactly one wsgi_server_runs edge from the config file', () => {
      const edges = store.getEdgesByType('wsgi_server_runs');
      expect(edges).toHaveLength(1);
    });

    it('extracts wsgi_app / bind / workers / worker_class into edge metadata', () => {
      const edges = store.getEdgesByType('wsgi_server_runs');
      const meta = edges[0].metadata ? JSON.parse(edges[0].metadata) : {};
      expect(meta.wsgi_app).toBe('wsgi:application');
      expect(meta.bind).toBe('0.0.0.0:8000');
      expect(meta.workers).toBe(4);
      expect(meta.worker_class).toBe('sync');
      expect(meta.file).toBe('gunicorn.conf.py');
    });
  });
});
