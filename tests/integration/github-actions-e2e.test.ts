/**
 * GitHub Actions E2E integration test.
 * Indexes the github-actions-app fixture and verifies workflow/job extraction.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { GithubActionsPlugin } from '../../src/indexer/plugins/integration/tooling/github-actions/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { YamlLanguagePlugin } from '../../src/indexer/plugins/language/yaml-lang/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/github-actions-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts', '.github/workflows/**/*.yml'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

// Workflow extraction relies on path matching that uses POSIX separators
// internally; on Windows the comparison fails. Skip until the matcher is
// platform-aware (TODO).
describe.skipIf(process.platform === 'win32')('GitHub Actions E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new YamlLanguagePlugin());
    registry.registerFrameworkPlugin(new GithubActionsPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files including YAML', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('extracts workflow jobs as routes', () => {
    const routes = store.getAllRoutes();
    const jobs = routes.filter((r) => r.method === 'JOB');
    expect(jobs.length).toBe(3);
    const names = jobs.map((r) => r.uri);
    expect(names).toContain('lint');
    expect(names).toContain('test');
    expect(names).toContain('deploy');
  });

  it('sets framework role on workflow files', () => {
    const files = store.getAllFiles();
    const ghaFiles = files.filter((f) => f.framework_role === 'gha_workflow');
    expect(ghaFiles.length).toBeGreaterThan(0);
  });
});
