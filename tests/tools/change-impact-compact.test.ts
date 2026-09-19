/**
 * ObservationPack prototype loop for get_change_impact (TRA-1700).
 *
 * Proves the harness-agnostic pattern: full ranked list (opt-in
 * emitAllDependents) → content-addressed archive → exact paged recall whose
 * concatenation equals the archived list, while the default capped path and
 * all summary stats stay exactly as before.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import {
  OBSERVATION_FIRST_PAGE_ITEMS,
  pageItems,
  recallObservation,
  storeObservation,
} from '../../src/observation-pack.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { getChangeImpact } from '../../src/tools/analysis/impact.js';
import { createTestStore, createTmpDir, removeTmpDir, writeFixtureFile } from '../test-utils.js';

const CONSUMER_COUNT = 60;

describe('change_impact compact loop', () => {
  let store: Store;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-impact-compact-');
    writeFixtureFile(
      tmpDir,
      'src/hub.ts',
      'export function hub(x: number): number {\n  return x;\n}\n',
    );
    for (let i = 0; i < CONSUMER_COUNT; i++) {
      writeFixtureFile(
        tmpDir,
        `src/consumer${i}.ts`,
        `import { hub } from './hub.js';\nexport function use${i}(): number {\n  return hub(${i});\n}\n`,
      );
    }
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const pipeline = new IndexingPipeline(
      store,
      registry,
      {
        root: tmpDir,
        include: ['src/**/*.ts'],
        exclude: ['node_modules/**'],
        plugins: [],
      } as never,
      tmpDir,
    );
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
  });

  it('default path stays capped; opt-in emits the full ranked list', () => {
    const capped = getChangeImpact(
      store,
      { symbolId: 'src/hub.ts::hub#function' } as never,
      3,
      500,
    );
    const full = getChangeImpact(
      store,
      { symbolId: 'src/hub.ts::hub#function', emitAllDependents: true } as never,
      3,
      500,
    );
    expect(capped.isOk() && full.isOk()).toBe(true);
    const cappedImpact = capped._unsafeUnwrap();
    const fullImpact = full._unsafeUnwrap();

    expect(cappedImpact.dependents.length).toBeLessThanOrEqual(25);
    expect(fullImpact.totalAffected).toBeGreaterThanOrEqual(CONSUMER_COUNT);
    expect(fullImpact.dependents.length).toBe(fullImpact.totalAffected);
    // First page of the full list is exactly the legacy capped slice.
    expect(fullImpact.dependents.slice(0, cappedImpact.dependents.length)).toEqual(
      cappedImpact.dependents,
    );
  });

  it('summary stats are identical capped vs full (counts stay exact)', () => {
    const capped = getChangeImpact(
      store,
      { symbolId: 'src/hub.ts::hub#function' } as never,
      3,
      500,
    )._unsafeUnwrap();
    const full = getChangeImpact(
      store,
      { symbolId: 'src/hub.ts::hub#function', emitAllDependents: true } as never,
      3,
      500,
    )._unsafeUnwrap();
    expect(full.summary).toEqual(capped.summary);
    expect(full.risk).toEqual(capped.risk);
    expect(full.totalAffected).toBe(capped.totalAffected);
  });

  it('archive → recall pages concatenate back to the full list', () => {
    const full = getChangeImpact(
      store,
      { symbolId: 'src/hub.ts::hub#function', emitAllDependents: true } as never,
      3,
      500,
    )._unsafeUnwrap();
    const stored = storeObservation(
      'get_change_impact',
      'src/hub.ts::hub#function',
      full.dependents,
    );
    expect(stored.totalItems).toBe(full.dependents.length);

    const seen: unknown[] = [];
    let offset = 0;
    for (let i = 0; i < 10; i++) {
      const page = recallObservation(stored.id, offset, OBSERVATION_FIRST_PAGE_ITEMS);
      seen.push(...page.items);
      offset = page.nextOffset;
      if (page.eof) break;
    }
    expect(seen).toEqual(full.dependents);
  });

  it('cleanup', () => {
    void pageItems;
    removeTmpDir(tmpDir);
    expect(true).toBe(true);
  });
});
