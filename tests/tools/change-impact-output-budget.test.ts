/**
 * Regression: get_change_impact output must stay bounded for a high-fan-in
 * symbol. The client report ("get_change_impact dumps ~13K tokens of JSON")
 * came from uncapped list fields — chiefly `affectedTests.files` and a fully
 * enumerated `dependents` array — ballooning for central symbols.
 *
 * Summary counts (totalAffected, byModule counts) must remain EXACT; only the
 * enumerated samples are capped, and `truncated` flags that the lists are not
 * exhaustive.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { getChangeImpact } from '../../src/tools/analysis/impact.js';
import { createTestStore, createTmpDir, removeTmpDir, writeFixtureFile } from '../test-utils.js';

const CONSUMER_COUNT = 60;

describe('get_change_impact output budget', () => {
  let store: Store;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-impact-budget-');
    // One central target...
    writeFixtureFile(
      tmpDir,
      'src/hub.ts',
      'export function hub(x: number): number {\n  return x;\n}\n',
    );
    // ...consumed by many files, each calling it from an exported function.
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
    const config = {
      root: tmpDir,
      include: ['src/**/*.ts'],
      exclude: ['node_modules/**'],
      db: { path: ':memory:' },
      plugins: [],
    } as never;
    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
  });

  afterEach(() => {
    /* store is shared across the describe; cleanup in a final hook */
  });

  it('caps the enumerated dependents list while keeping totalAffected exact', () => {
    const res = getChangeImpact(store, { symbolId: 'src/hub.ts::hub#function' } as never, 3, 500);
    expect(res.isOk()).toBe(true);
    const impact = res._unsafeUnwrap();

    // Many consumers were found...
    expect(impact.totalAffected).toBeGreaterThanOrEqual(CONSUMER_COUNT);
    expect(impact.summary.totalFiles).toBe(impact.totalAffected);

    // ...but the enumerated list is bounded and flagged as truncated.
    expect(impact.dependents.length).toBeLessThanOrEqual(25);
    expect(impact.dependents.length).toBeLessThan(impact.totalAffected);
    expect(impact.truncated).toBe(true);

    // Each emitted dependent's symbol detail is also bounded.
    for (const dep of impact.dependents) {
      if (dep.symbols) expect(dep.symbols.length).toBeLessThanOrEqual(4);
    }
  });

  it('keeps the whole response well under the previous ~13K-token bloat', () => {
    const res = getChangeImpact(store, { symbolId: 'src/hub.ts::hub#function' } as never, 3, 500);
    const impact = res._unsafeUnwrap();
    const approxTokens = JSON.stringify(impact).length / 4;
    // 60 dependents previously emitted in full; capped output must be modest.
    expect(approxTokens).toBeLessThan(6000);
  });

  it('byModule counts remain exact even when file lists are capped', () => {
    const res = getChangeImpact(store, { symbolId: 'src/hub.ts::hub#function' } as never, 3, 500);
    const impact = res._unsafeUnwrap();
    const totalFromModules = (impact.byModule ?? []).reduce((sum, m) => sum + m.count, 0);
    expect(totalFromModules).toBe(impact.totalAffected);
    // Each module's enumerated files are capped at 15.
    for (const m of impact.byModule ?? []) {
      expect(m.files.length).toBeLessThanOrEqual(15);
      expect(m.files.length).toBeLessThanOrEqual(m.count);
    }
  });

  it('cleanup', () => {
    removeTmpDir(tmpDir);
    expect(true).toBe(true);
  });
});
