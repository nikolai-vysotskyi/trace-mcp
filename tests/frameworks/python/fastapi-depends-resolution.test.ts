/**
 * Regression: FastAPI `Depends(dep)` must create a symbol-level edge from the
 * route handler to the dependency function, cross-file. Previously the
 * dependency (e.g. `get_session`) had zero graph dependents because
 * `fastapi_depends` was a metadata-only edge with no resolvable target. The
 * FastAPI plugin now resolves it in pass 2 (resolveEdges).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { FastAPIPlugin } from '../../../src/indexer/plugins/integration/framework/fastapi/index.js';
import { IndexingPipeline } from '../../../src/indexer/pipeline.js';
import { PythonLanguagePlugin } from '../../../src/indexer/plugins/language/python/index.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { createTestStore, createTmpDir, removeTmpDir, writeFixtureFile } from '../../test-utils.js';

describe('FastAPI Depends() cross-file resolution', () => {
  let store: Store;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-fastapi-depends-');
    writeFixtureFile(
      tmpDir,
      'pyproject.toml',
      '[project]\nname = "x"\ndependencies = ["fastapi"]\n',
    );
    writeFixtureFile(
      tmpDir,
      'db.py',
      ['def get_session():', '    yield 1', '', 'def get_current_user():', '    return None'].join(
        '\n',
      ),
    );
    writeFixtureFile(
      tmpDir,
      'main.py',
      [
        'from fastapi import FastAPI, Depends',
        'from db import get_session, get_current_user',
        '',
        'app = FastAPI()',
        '',
        '@app.get("/items")',
        'def list_items(session=Depends(get_session), user=Depends(get_current_user)):',
        '    return []',
      ].join('\n'),
    );

    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    registry.registerFrameworkPlugin(new FastAPIPlugin());
    const config = {
      root: tmpDir,
      include: ['**/*.py'],
      exclude: [],
      db: { path: ':memory:' },
      plugins: [],
    } as never;
    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
  });

  afterAll(() => removeTmpDir(tmpDir));

  function dependsEdges(): string[] {
    return (
      store.db
        .prepare(`
      SELECT s1.name AS handler, s2.name AS dependency
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'fastapi_depends'
    `)
        .all() as { handler: string; dependency: string }[]
    ).map((e) => `${e.handler} → ${e.dependency}`);
  }

  it('links the handler to each cross-file dependency function', () => {
    const pairs = dependsEdges();
    expect(pairs).toContain('list_items → get_session');
    expect(pairs).toContain('list_items → get_current_user');
  });

  it('makes the dependency function reachable as a dependent (no self-loops)', () => {
    const selfLoops = (
      store.db
        .prepare(`
      SELECT COUNT(*) AS cnt FROM edges e
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'fastapi_depends' AND e.source_node_id = e.target_node_id
    `)
        .get() as { cnt: number }
    ).cnt;
    expect(selfLoops).toBe(0);
  });
});
