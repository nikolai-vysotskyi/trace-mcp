/**
 * TRA-1828 — bulk passes must not hold the event loop in one synchronous
 * span. `persistBatch` commits in 50-file chunked transactions and
 * `reconcileScope` deletes in 200-row chunks, each with a fair yield
 * between chunks. This test drives both chunked paths past their chunk
 * boundary in one run (120 real files > 50 persist chunk; 250 stale rows >
 * 200 reconcile chunk) and asserts the index still converges exactly.
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
import { IndexingPipeline } from '../pipeline.js';
import { PERSIST_WRITE_CHUNK } from '../file-persister.js';

const FILE_COUNT = PERSIST_WRITE_CHUNK * 2 + 20; // 120: forces 3 persist chunks
const STALE_COUNT = 250; // forces 2 reconcile-delete chunks

describe('bulk chunked persist + reconcile (TRA-1828)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'bulk-chunk-1828-'));
    mkdirSync(join(workDir, 'src'), { recursive: true });
    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(
        join(workDir, 'src', `f${i}.ts`),
        `export function fn${i}() { return ${i}; }\n`,
      );
    }
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function makePipeline(store: Store) {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = TraceMcpConfigSchema.parse({
      root: workDir,
      include: ['**/*.ts'],
      exclude: [],
    });
    return new IndexingPipeline(store, registry, config, workDir);
  }

  it('indexes every file across persist chunks and drops stale rows across delete chunks', async () => {
    const store = new Store(initializeDatabase(':memory:'));

    // Poison the index with stale rows from a previous version, as in
    // scope-reconcile.test.ts — enough to cross the delete-chunk boundary.
    for (let i = 0; i < STALE_COUNT; i++) {
      const id = store.insertFile(`old/stale${i}.ts`, 'typescript', 'old', 40, null, null);
      store.insertSymbol(id, {
        symbolId: `old/stale${i}.ts::ghost${i}#function`,
        name: `ghost${i}`,
        kind: 'function',
        byteStart: 0,
        byteEnd: 10,
        lineStart: 1,
        lineEnd: 1,
      });
    }
    expect(store.getAllFiles()).toHaveLength(STALE_COUNT);

    const result = await makePipeline(store).indexAll();

    expect(result.totalFiles).toBe(FILE_COUNT);
    expect(result.indexed).toBe(FILE_COUNT);
    expect(result.errors).toBe(0);

    const paths = store.getAllFiles().map((f) => f.path);
    expect(paths).toHaveLength(FILE_COUNT);
    expect(paths).toContain('src/f0.ts');
    expect(paths).toContain(`src/f${FILE_COUNT - 1}.ts`);
    expect(paths.some((p) => p.startsWith('old/'))).toBe(false);

    // Spot-check symbol content landed, not just file rows.
    const names = new Set(
      store.getAllFiles().flatMap((f) => store.getSymbolsByFile(f.id).map((s) => s.name)),
    );
    expect(names.has('fn0')).toBe(true);
    expect(names.has(`fn${FILE_COUNT - 1}`)).toBe(true);
    expect(names.has('ghost0')).toBe(false);
  }, 120_000);
});
