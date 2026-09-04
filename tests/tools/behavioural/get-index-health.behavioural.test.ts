/**
 * Behavioural coverage for `getIndexHealth()`. Verifies status routing
 * (ok/empty/degraded), the warning emitted when symbols-without-edges
 * indicates linker failure, and the output shape.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../../src/config.js';
import { initializeDatabase } from '../../../src/db/schema.js';
import { Store } from '../../../src/db/store.js';
import { getIndexHealth } from '../../../src/tools/project/project.js';
import { createTestStore } from '../../test-utils.js';

function makeConfig(): TraceMcpConfig {
  return {
    root: '.',
    include: ['**/*.ts'],
    exclude: ['node_modules/**'],
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

  it('dbPath is the file the store was opened at, not a config default (TRA-802)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-health-'));
    const dbPath = path.join(dir, 'index.db');
    const store = new Store(initializeDatabase(dbPath));

    try {
      expect(getIndexHealth(store, makeConfig()).config.dbPath).toBe(dbPath);
    } finally {
      store.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('omits the embedding block when AI is off and nothing has failed', () => {
    ctx.store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
    expect(getIndexHealth(ctx.store, ctx.config).embedding).toBeUndefined();
  });

  // TRA-812: a paused embedding backlog degraded semantic search silently for
  // two days. get_index_health is the surface that has to say so.
  it('reports a paused embedding backlog as degraded, with the deadline and cause', () => {
    const fid = ctx.store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
    ctx.store.insertSymbol(fid, {
      symbolId: 'src/a.ts::unembedded#function',
      name: 'unembedded',
      kind: 'function',
      fqn: 'unembedded',
      byteStart: 0,
      byteEnd: 30,
      lineStart: 1,
      lineEnd: 3,
    });
    const pausedUntil = Date.now() + 600_000;
    ctx.store.db.prepare('INSERT OR REPLACE INTO server_state (key, value) VALUES (?, ?)').run(
      'embedding_breaker',
      JSON.stringify({
        disabledUntilMs: pausedUntil,
        consecutiveFailures: 2,
        lastFailureAt: Date.now(),
        lastError: 'fetch failed',
      }),
    );

    const result = getIndexHealth(ctx.store, ctx.config);
    expect(result.embedding?.queued).toBe(1);
    expect(result.embedding?.pausedUntil).toBe(pausedUntil);
    expect(result.embedding?.lastError).toBe('fetch failed');
    expect(result.status).toBe('degraded');
    expect(result.warnings.some((w) => /queued for embedding.*paused/s.test(w))).toBe(true);
  });

  it('an elapsed pause is not reported as paused', () => {
    ctx.store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
    ctx.store.db.prepare('INSERT OR REPLACE INTO server_state (key, value) VALUES (?, ?)').run(
      'embedding_breaker',
      JSON.stringify({
        disabledUntilMs: Date.now() - 1_000,
        consecutiveFailures: 2,
        lastFailureAt: Date.now() - 601_000,
        lastError: 'fetch failed',
      }),
    );

    const result = getIndexHealth(ctx.store, ctx.config);
    expect(result.embedding?.pausedUntil).toBeUndefined();
    // The last failure is still worth reporting — it explains a stale backlog.
    expect(result.embedding?.lastError).toBe('fetch failed');
    expect(result.status).toBe('ok');
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
