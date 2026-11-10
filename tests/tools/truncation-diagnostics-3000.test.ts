import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { getProjectMap } from '../../src/tools/project/project.js';
import { getMinimalContext } from '../../src/tools/project/minimal-context.js';
import {
  META_INDEX_TRUNCATED,
  META_INDEX_TRUNCATED_FOUND,
  META_INDEX_TRUNCATED_LIMIT,
} from '../../src/indexer/pipeline.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { ProjectContext } from '../../src/plugin-api/types.js';

function emptyConfig(): TraceMcpConfig {
  return {} as TraceMcpConfig;
}

function emptyCtx(): ProjectContext {
  return {
    rootPath: '/tmp/test-project-3000',
    configFiles: [],
    allDependencies: [],
  };
}

function fixture() {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const registry = new PluginRegistry();
  return { db, store, registry };
}

describe('TRA-3000: explicit truncation state and diagnostics in orientation tools', () => {
  it('getProjectMap: omits truncated field and truncation diagnostic when index is untruncated', () => {
    const { store, registry } = fixture();
    store.insertFile('src/index.ts', 'typescript', 'hash1', 100, null, null);

    // Summary mode
    const summary = getProjectMap(store, registry, true, emptyCtx());
    expect(summary.truncated).toBeUndefined();
    expect(summary.diagnostics).toBeUndefined();

    // Full mode
    const full = getProjectMap(store, registry, false, emptyCtx());
    expect(full.truncated).toBeUndefined();
    expect(full.diagnostics).toBeUndefined();
  });

  it('getProjectMap: surfaces truncated object and clear diagnostic warning when index is truncated', () => {
    const { store, registry } = fixture();
    store.insertFile('src/index.ts', 'typescript', 'hash1', 100, null, null);

    // Stamp truncation metadata
    store.setRepoMetadata(META_INDEX_TRUNCATED, '1');
    store.setRepoMetadata(META_INDEX_TRUNCATED_FOUND, '19967');
    store.setRepoMetadata(META_INDEX_TRUNCATED_LIMIT, '10000');

    // 1. Summary mode
    const summary = getProjectMap(store, registry, true, emptyCtx());
    expect(summary.truncated).toEqual({ found: 19967, limit: 10000 });
    expect(summary.diagnostics).toBeDefined();
    expect(
      summary.diagnostics?.some((d) =>
        d.includes('File count exceeds security.max_files limit (19967 found, capped at 10000)'),
      ),
    ).toBe(true);
    expect(
      summary.diagnostics?.some((d) =>
        d.includes('Increase security.max_files in config to index more.'),
      ),
    ).toBe(true);

    // 2. Full mode
    const full = getProjectMap(store, registry, false, emptyCtx());
    expect(full.truncated).toEqual({ found: 19967, limit: 10000 });
    expect(full.diagnostics).toBeDefined();
    expect(
      full.diagnostics?.some((d) =>
        d.includes('File count exceeds security.max_files limit (19967 found, capped at 10000)'),
      ),
    ).toBe(true);
  });

  it('getMinimalContext: surfaces project.truncated and next_steps recommendation when index is truncated', () => {
    const { store, registry } = fixture();
    store.insertFile('src/index.ts', 'typescript', 'hash1', 100, null, null);

    // Untruncated first
    const normal = getMinimalContext(
      store,
      registry,
      emptyConfig(),
      '/tmp/test-project-3000',
      emptyCtx(),
      {},
    );
    expect(normal.project.truncated).toBeUndefined();
    expect(normal.next_steps.some((s) => s.tool === 'get_index_health')).toBe(false);

    // Now stamped as truncated
    store.setRepoMetadata(META_INDEX_TRUNCATED, '1');
    store.setRepoMetadata(META_INDEX_TRUNCATED_FOUND, '18347');
    store.setRepoMetadata(META_INDEX_TRUNCATED_LIMIT, '10000');

    const truncated = getMinimalContext(
      store,
      registry,
      emptyConfig(),
      '/tmp/test-project-3000',
      emptyCtx(),
      {},
    );
    expect(truncated.project.truncated).toEqual({ found: 18347, limit: 10000 });
    const healthStep = truncated.next_steps.find((s) => s.tool === 'get_index_health');
    expect(healthStep).toBeDefined();
    expect(healthStep?.hint).toContain('Index is partial: capped at 10000 of 18347 files on disk.');
    expect(healthStep?.hint).toContain('Increase security.max_files in config to index more.');
  });
});
