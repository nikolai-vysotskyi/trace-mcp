/**
 * TRA-1543 — incremental overhead guards.
 *
 * Two costs used to repeat on every indexAll run for zero benefit:
 *   1. ANALYZE on the walk path ran unconditionally (~24 ms per run);
 *      now throttled to once per ANALYZE_THROTTLE_MS.
 *   2. Workspace framework detection ran twice per run (once for edge-type
 *      registration, once for edge resolution); now computed once and shared.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { TraceMcpConfigSchema } from '../../config.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { TypeScriptLanguagePlugin } from '../plugins/language/typescript/index.js';
import { ANALYZE_THROTTLE_MS, IndexingPipeline, META_LAST_ANALYZE_MS } from '../pipeline.js';

describe('TRA-1543 incremental overhead', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'tra-1543-'));
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function makePipeline(store: Store, registry?: PluginRegistry) {
    const reg =
      registry ??
      (() => {
        const r = new PluginRegistry();
        r.registerLanguagePlugin(new TypeScriptLanguagePlugin());
        return r;
      })();
    const config = TraceMcpConfigSchema.parse({
      root: workDir,
      include: ['**/*.ts'],
      exclude: [],
    });
    return new IndexingPipeline(store, reg, config, workDir);
  }

  it('throttles ANALYZE to once per window across full-walk indexAll runs', async () => {
    const rawDb = initializeDatabase(':memory:');
    const store = new Store(rawDb);
    let analyzeCalls = 0;
    const origExec = rawDb.exec.bind(rawDb);
    (rawDb as unknown as { exec: (sql: string) => void }).exec = (sql: string) => {
      if (/^\s*ANALYZE\b/i.test(sql)) analyzeCalls++;
      return origExec(sql);
    };
    const pipeline = makePipeline(store);

    await pipeline.indexAll(false);
    expect(analyzeCalls).toBe(1);
    expect(store.getRepoMetadata(META_LAST_ANALYZE_MS)).not.toBeNull();

    // Second full walk inside the throttle window must not re-ANALYZE.
    analyzeCalls = 0;
    await pipeline.indexAll(false, { discovery: 'full-walk' });
    expect(analyzeCalls).toBe(0);

    // A stale stamp re-arms it.
    store.setRepoMetadata(META_LAST_ANALYZE_MS, String(Date.now() - ANALYZE_THROTTLE_MS - 1000));
    analyzeCalls = 0;
    await pipeline.indexAll(false, { discovery: 'full-walk' });
    expect(analyzeCalls).toBe(1);

    await pipeline.dispose();
    rawDb.close();
  });

  it('detects workspace plugins once per run, shared by register + resolve', async () => {
    // One implicit workspace: a subdir with its own package.json.
    mkdirSync(join(workDir, 'packages', 'web'), { recursive: true });
    writeFileSync(
      join(workDir, 'packages', 'web', 'package.json'),
      JSON.stringify({ name: 'web' }),
    );
    writeFileSync(
      join(workDir, 'packages', 'web', 'index.ts'),
      'export function web() { return 2; }\n',
    );

    const rawDb = initializeDatabase(':memory:');
    const store = new Store(rawDb);
    const registry = PluginRegistry.createWithDefaults();
    const plugins = registry.getAllFrameworkPlugins();
    expect(plugins.length).toBeGreaterThan(0);
    let detectCalls = 0;
    for (const p of plugins) {
      const orig = p.detect.bind(p);
      p.detect = (...args: Parameters<typeof orig>) => {
        detectCalls++;
        return orig(...args);
      };
    }
    const pipeline = makePipeline(store, registry);

    await pipeline.indexAll(false);

    // Root context once per plugin + each workspace once per plugin.
    // Before the fix the workspace share ran three times per run
    // (edge-type registration, extraction, edge resolution).
    const workspaces = (pipeline as unknown as { workspaces: unknown[] }).workspaces;
    expect(detectCalls).toBe(plugins.length * (1 + workspaces.length));

    // An incremental run that touches no manifest reuses the workspace map:
    // only the root round re-detects.
    detectCalls = 0;
    writeFileSync(join(workDir, 'src', 'a.ts'), 'export function alpha2() { return 2; }\n');
    await pipeline.indexFiles(['src/a.ts']);
    expect(detectCalls).toBe(plugins.length);

    // A manifest in scope re-arms workspace detection.
    detectCalls = 0;
    writeFileSync(
      join(workDir, 'packages', 'web', 'package.json'),
      JSON.stringify({ name: 'web2' }),
    );
    await pipeline.indexFiles(['packages/web/package.json']);
    expect(detectCalls).toBe(plugins.length * (1 + workspaces.length));

    // A fresh pipeline instance on the same store reloads the persisted map
    // through the incremental fast path: workspace detection costs zero
    // detects, only the per-run root round. Uses the TRA-1576 discovery seam
    // to force the fast path on a non-git tmpdir.
    const config2 = TraceMcpConfigSchema.parse({
      root: workDir,
      include: ['**/*.ts'],
      exclude: [],
    });
    const pipeline2 = new IndexingPipeline(store, registry, config2, workDir, undefined, {
      incrementalDiscovery: {
        discover: async () => ({
          source: 'watcher-since' as const,
          changed: ['src/a.ts'],
          deleted: [],
        }),
        snapshotPath: null,
        queryGit: null,
      },
    });
    detectCalls = 0;
    writeFileSync(join(workDir, 'src', 'a.ts'), 'export function alpha3() { return 3; }\n');
    const r2 = await pipeline2.indexAll(false);
    expect(r2.indexed).toBe(1);
    expect(detectCalls).toBe(plugins.length);
    await pipeline2.dispose();

    await pipeline.dispose();
    rawDb.close();
  });
});
