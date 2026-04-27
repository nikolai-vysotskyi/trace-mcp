/**
 * Reproduction test for GitHub issue #54:
 * get_change_impact under-counts method-level dependents for overrides.
 *
 * Verifies that getChangeImpact and findReferences agree on
 * method-level incoming edges for instance.method() call patterns,
 * INCLUDING when the instance type comes from parameter annotations.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { getChangeImpact } from '../../src/tools/analysis/impact.js';
import { findReferences } from '../../src/tools/framework/references.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/python-project');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['**/*.py'],
    exclude: ['__pycache__/**', 'venv/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Issue #54: method-level impact analysis', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
  });

  // ── Constructor-based type inference (already works) ──

  it('finds dependents of User.save via constructor inference (var = User(...))', () => {
    const symbolId = 'myapp/models/user.py::User::save#method';
    const result = getChangeImpact(store, { symbolId });
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    // get_user() creates `user = User(...)` then calls `user.save()`
    expect(impact.dependents.some((d) => d.path === 'myapp/views/user_views.py')).toBe(true);
  });

  // ── Parameter annotation inference (the bug) ──

  it('resolves method calls on parameter-annotated instances to edges', () => {
    // verify_and_save(user: User, ...) calls user.save() and user.validate()
    const callEdges = store.db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'verify_and_save'
    `)
      .all() as { caller: string; callee: string }[];

    const callees = callEdges.map((e) => e.callee);
    // user.save() where user: User comes from parameter annotation
    expect(callees).toContain('save');
    // user.validate() resolves to BaseModel.validate (inherited) — this works
    // because the call resolver checks the class then falls back to inherited methods
    expect(callees).toContain('validate');
  });

  it('get_change_impact finds dependents via parameter-annotated callers', () => {
    const symbolId = 'myapp/models/user.py::User::save#method';
    const result = getChangeImpact(store, { symbolId });
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    const impactFiles = impact.dependents.map((d) => d.path);

    // verify_and_save(user: User) calls user.save() → should appear as dependent
    expect(impactFiles).toContain('myapp/views/api_proxy.py');
  });

  it('get_change_impact finds dependents of User.get_display_name via param annotation', () => {
    const symbolId = 'myapp/models/user.py::User::get_display_name#method';
    const result = getChangeImpact(store, { symbolId });
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    const impactFiles = impact.dependents.map((d) => d.path);

    // get_display(user: User) calls user.get_display_name() → should be a dependent
    expect(impactFiles).toContain('myapp/views/api_proxy.py');
  });

  it('find_usages and get_change_impact agree on all method-level dependents', () => {
    const symbolId = 'myapp/models/user.py::User::save#method';

    const refsResult = findReferences(store, { symbolId });
    expect(refsResult.isOk()).toBe(true);
    const refs = refsResult._unsafeUnwrap();

    const impactResult = getChangeImpact(store, { symbolId });
    expect(impactResult.isOk()).toBe(true);
    const impact = impactResult._unsafeUnwrap();

    // Get unique files from find_usages (calls edges only)
    const refFiles = new Set(
      refs.references.filter((r) => r.edge_type === 'calls').map((r) => r.file),
    );

    // Get files from get_change_impact
    const impactFiles = new Set(impact.dependents.map((d) => d.path));

    // Every file that find_usages reports should also appear in get_change_impact
    for (const file of refFiles) {
      expect(impactFiles.has(file)).toBe(true);
    }
  });
});
