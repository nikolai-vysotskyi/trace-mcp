/**
 * Behavioural coverage for `getIndexHealth()`. Verifies status routing
 * (ok/empty/degraded), the warning emitted when symbols-without-edges
 * indicates linker failure, and the output shape.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../../src/config.js';
import { Store } from '../../../src/db/store.js';
import { getIndexHealth } from '../../../src/tools/project/project.js';
import { createTestStore } from '../../test-utils.js';

function makeConfig(): TraceMcpConfig {
  return {
    root: '.',
    include: ['**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  } as unknown as TraceMcpConfig;
}

interface Fixture {
  store: Store;
  config: TraceMcpConfig;
}

describe('getIndexHealth() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = { store: createTestStore(), config: makeConfig() };
  });

  it('empty index → status="empty", zero counts, schemaVersion > 0', () => {
    const result = getIndexHealth(ctx.store, ctx.config);
    expect(result.status).toBe('empty');
    expect(result.stats.totalFiles).toBe(0);
    expect(result.stats.totalSymbols).toBe(0);
    expect(result.stats.totalEdges).toBe(0);
    expect(result.schemaVersion).toBeGreaterThan(0);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('seeded files → status="ok" and stats reflect the seed', () => {
    ctx.store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
    ctx.store.insertFile('src/b.py', 'python', 'h-b', 50);

    const result = getIndexHealth(ctx.store, ctx.config);
    expect(result.status).toBe('ok');
    expect(result.stats.totalFiles).toBe(2);
  });

  it('output shape: { status, stats, schemaVersion, config, warnings }', () => {
    ctx.store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
    const result = getIndexHealth(ctx.store, ctx.config);

    expect(typeof result.status).toBe('string');
    expect(['ok', 'degraded', 'empty']).toContain(result.status);
    expect(result.stats).toBeDefined();
    expect(typeof result.stats.totalFiles).toBe('number');
    expect(typeof result.stats.totalSymbols).toBe('number');
    expect(typeof result.stats.totalEdges).toBe('number');
    expect(typeof result.schemaVersion).toBe('number');
    expect(result.config).toBeDefined();
    expect(result.config.dbPath).toBe(':memory:');
    expect(Array.isArray(result.config.includePatterns)).toBe(true);
    expect(Array.isArray(result.config.excludePatterns)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('symbols indexed but zero edges → status="degraded" with linker-failure warning', () => {
    const fid = ctx.store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
    ctx.store.insertSymbol(fid, {
      symbolId: 'src/a.ts::orphan#function',
      name: 'orphan',
      kind: 'function',
      fqn: 'orphan',
      byteStart: 0,
      byteEnd: 30,
      lineStart: 1,
      lineEnd: 3,
    });

    const result = getIndexHealth(ctx.store, ctx.config);
    expect(result.status).toBe('degraded');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => /edges/i.test(w))).toBe(true);
  });

  it('reflects include/exclude patterns from the supplied config', () => {
    const custom: TraceMcpConfig = {
      ...ctx.config,
      include: ['src/**/*.ts', 'lib/**/*.ts'],
      exclude: ['dist/**', 'tmp/**'],
    } as TraceMcpConfig;

    const result = getIndexHealth(ctx.store, custom);
    expect(result.config.includePatterns).toEqual(['src/**/*.ts', 'lib/**/*.ts']);
    expect(result.config.excludePatterns).toEqual(['dist/**', 'tmp/**']);
  });
});
