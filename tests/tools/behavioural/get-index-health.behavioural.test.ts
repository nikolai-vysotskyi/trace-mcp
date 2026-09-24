/**
 * Behavioural coverage for `getIndexHealth()`. Verifies status routing
 * (ok/empty/degraded), the warning emitted when symbols-without-edges
 * indicates linker failure, and the output shape.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as parcelWatcher from '@parcel/watcher';
import type { TraceMcpConfig } from '../../../src/config.js';
import { initializeDatabase } from '../../../src/db/schema.js';
import { Store } from '../../../src/db/store.js';
import { FileWatcher, resetDroppedEventStats } from '../../../src/indexer/watcher.js';
import { getIndexHealth } from '../../../src/tools/project/project.js';
import { createTestStore } from '../../test-utils.js';

type WatcherCallback = (err: Error | null, events: parcelWatcher.Event[]) => void | Promise<void>;

let capturedCallback: WatcherCallback | null = null;

vi.mock('@parcel/watcher', () => ({
  subscribe: async (_root: string, cb: WatcherCallback) => {
    capturedCallback = cb;
    return { unsubscribe: async () => {} };
  },
}));

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

/**
 * Two linked function symbols in one file. The edge keeps the linker-failure
 * check quiet so embedding assertions read cleanly; `embedded` controls
 * whether both symbols already have vectors.
 */
function seedLinkedSymbols(store: Store, embedded: boolean): void {
  const fid = store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
  const mk = (name: string, start: number) =>
    store.insertSymbol(fid, {
      symbolId: `src/a.ts::${name}#function`,
      name,
      kind: 'function',
      fqn: name,
      byteStart: start,
      byteEnd: start + 10,
      lineStart: 1,
      lineEnd: 2,
    });
  const a = mk('alpha', 0);
  const b = mk('beta', 20);
  if (embedded) {
    for (const id of [a, b]) {
      store.db
        .prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)')
        .run(id, Buffer.from(new Float32Array([0.1, 0.2]).buffer));
    }
  }
  const aNode = store.getNodeId('symbol', a);
  const bNode = store.getNodeId('symbol', b);
  if (aNode === undefined || bNode === undefined) throw new Error('symbol nodes not created');
  store.insertEdge(aNode, bNode, 'calls');
}

function aiEnabledConfig(base: TraceMcpConfig): TraceMcpConfig {
  return { ...base, ai: { enabled: true } } as unknown as TraceMcpConfig;
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

  it('no symbols → no embedding block (nothing to cover)', () => {
    ctx.store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
    expect(getIndexHealth(ctx.store, ctx.config).embedding).toBeUndefined();
  });

  // TRA-1904: a 0%-covered project used to read as healthy with an absent
  // embedding block. Coverage is now reported whenever symbols exist — even
  // with AI off — so FTS-only search is visible, not silent.
  it('AI off with symbols → coverage 0% with enabled=false and an FTS-only warning, status stays ok', () => {
    seedLinkedSymbols(ctx.store, false);

    const result = getIndexHealth(ctx.store, ctx.config);
    expect(result.embedding).toMatchObject({
      enabled: false,
      totalSymbols: 2,
      embedded: 0,
      coveragePct: 0,
      queued: 2,
    });
    // Lexical-only is a supported operator choice — warn, don't degrade.
    expect(result.status).toBe('ok');
    expect(result.warnings.some((w) => /FTS-only/.test(w))).toBe(true);
  });

  // TRA-1904: an undrained backlog with no breaker row (fresh reindex while
  // the provider was down, or background pass not yet fired) used to read as
  // healthy with silently partial semantic ranking.
  it('AI on with an undrained backlog and no breaker → degraded with a backfill warning', () => {
    seedLinkedSymbols(ctx.store, false);

    const result = getIndexHealth(ctx.store, aiEnabledConfig(ctx.config));
    expect(result.embedding).toMatchObject({
      enabled: true,
      totalSymbols: 2,
      embedded: 0,
      coveragePct: 0,
      queued: 2,
    });
    expect(result.status).toBe('degraded');
    expect(result.warnings.some((w) => /call embed_repo to backfill/.test(w))).toBe(true);
  });

  it('AI on with full coverage → 100% block, no embedding warning, status ok', () => {
    seedLinkedSymbols(ctx.store, true);

    const result = getIndexHealth(ctx.store, aiEnabledConfig(ctx.config));
    expect(result.embedding).toMatchObject({
      enabled: true,
      totalSymbols: 2,
      embedded: 2,
      coveragePct: 100,
      queued: 0,
    });
    expect(result.warnings.some((w) => /embed/i.test(w))).toBe(false);
    expect(result.status).toBe('ok');
  });

  // TRA-812: a paused embedding backlog degraded semantic search silently for
  // two days. get_index_health is the surface that has to say so. (A pause
  // can only happen while the pipeline runs, so this uses an AI-enabled
  // config — the realistic setup.)
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

    const result = getIndexHealth(ctx.store, aiEnabledConfig(ctx.config));
    expect(result.embedding?.queued).toBe(1);
    expect(result.embedding?.enabled).toBe(true);
    expect(result.embedding?.totalSymbols).toBe(1);
    expect(result.embedding?.coveragePct).toBe(0);
    expect(result.embedding?.pausedUntil).toBe(pausedUntil);
    expect(result.embedding?.lastError).toBe('fetch failed');
    expect(result.status).toBe('degraded');
    expect(result.warnings.some((w) => /queued for embedding.*paused/s.test(w))).toBe(true);
  });

  // TRA-1904: AI disabled now, but a stale breaker row explains why vectors
  // are missing. Warning, not degraded — nothing will run while disabled.
  it('AI off with a stale embedding failure → FTS-only warning names the prior failure', () => {
    seedLinkedSymbols(ctx.store, false);
    ctx.store.db.prepare('INSERT OR REPLACE INTO server_state (key, value) VALUES (?, ?)').run(
      'embedding_breaker',
      JSON.stringify({
        disabledUntilMs: Date.now() + 600_000,
        consecutiveFailures: 2,
        lastFailureAt: Date.now(),
        lastError: 'fetch failed',
      }),
    );

    const result = getIndexHealth(ctx.store, ctx.config);
    expect(result.embedding?.enabled).toBe(false);
    expect(result.embedding?.queued).toBe(2);
    expect(result.status).toBe('ok');
    expect(
      result.warnings.some((w) => /FTS-only/.test(w) && /before AI was disabled/.test(w)),
    ).toBe(true);
  });

  it('an elapsed pause is not reported as paused', () => {
    // Full vector coverage: no backlog, so the stale failure explains
    // nothing current — but the row is still surfaced for forensics.
    seedLinkedSymbols(ctx.store, true);
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
    expect(result.embedding?.coveragePct).toBe(100);
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

  // TRA-1534: an empty index must name the session root and point at the
  // relay, otherwise the agent improvises a vague "empty session DB" story.
  it('empty index with projectRoot → names the root and points at list_projects + call_project_tool', () => {
    const result = getIndexHealth(ctx.store, ctx.config, '/Users/nikolai/workdir');
    expect(result.status).toBe('empty');
    expect(result.projectRoot).toBe('/Users/nikolai/workdir');
    expect(result.next_steps).toContain('/Users/nikolai/workdir');
    expect(result.next_steps).toContain('list_projects');
    expect(result.next_steps).toContain('call_project_tool');
  });

  it('empty index without projectRoot → generic next_steps, no root field', () => {
    const result = getIndexHealth(ctx.store, ctx.config);
    expect(result.status).toBe('empty');
    expect(result.projectRoot).toBeUndefined();
    expect(result.next_steps).toContain('list_projects');
    expect(result.next_steps).toContain('call_project_tool');
  });

  it('non-empty index with projectRoot → root present, no next_steps', () => {
    ctx.store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
    const result = getIndexHealth(ctx.store, ctx.config, '/Users/nikolai/workdir');
    expect(result.status).toBe('ok');
    expect(result.projectRoot).toBe('/Users/nikolai/workdir');
    expect(result.next_steps).toBeUndefined();
  });

  // TRA-1665: once the storm breaker coalesces drops, get_index_health must
  // say so — the daemon log is not readable from an agent session.
  it('reports a reconcile-storm warning once the breaker coalesces drops', async () => {
    resetDroppedEventStats();
    const watcher = new FileWatcher();
    try {
      await watcher.start(process.cwd(), ctx.config, async () => {}, 10, undefined, {
        onRescan: async () => {},
      });
      // Four rapid drops: the third opens the breaker, the fourth is
      // coalesced (suppressed) however the in-flight passes interleave.
      for (let i = 0; i < 4; i++) {
        await capturedCallback!(new Error('Events were dropped by the FSEvents client.'), []);
      }
      ctx.store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
      const result = getIndexHealth(ctx.store, ctx.config);
      expect(result.status).toBe('degraded');
      expect(result.warnings.some((w) => w.includes('Reconcile storm backoff'))).toBe(true);
    } finally {
      await watcher.stop();
      resetDroppedEventStats();
    }
  });
});
