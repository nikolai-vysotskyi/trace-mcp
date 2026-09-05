/**
 * TRA-935: a reindex whose file list filters down to nothing must cost
 * nothing.
 *
 * Watcher / hook / `register_edit` events routinely name paths the indexer
 * has no business touching — git-ignored churn, `config.exclude` matches,
 * files under a more-specific registered project. Those were still running
 * the whole incremental pipeline: ignore-matcher rebuilds, a change-scope
 * build, and a full search + PageRank cache invalidation — and, worse, they
 * queued on the pipeline lock behind whatever real indexing was in flight.
 * One daemon log held 29 925 such events; their reported latency was the
 * queue wait, which is how `reindex-file` telemetry came to show elapsed
 * times in the hours.
 *
 * The guard belongs in front of the lock, so both properties are pinned here:
 * the run does no work, and it does not wait for one that is.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { IndexingPipeline } from '../pipeline.js';

let workDir: string;
let db: Database.Database;
let store: Store;
let pipeline: IndexingPipeline;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zero-file-reindex-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  for (let i = 0; i < 20; i++) {
    writeFileSync(
      join(workDir, 'src', `m${i}.ts`),
      `export function f${i}(): number { return ${i}; }\n`,
    );
  }
  // Excluded by config below, so a watcher event naming it must be a no-op.
  mkdirSync(join(workDir, 'vendor'), { recursive: true });
  writeFileSync(join(workDir, 'vendor', 'dep.ts'), 'export const dep = 1;\n');

  db = initializeDatabase(join(workDir, 'index.db'));
  store = new Store(db);
  pipeline = new IndexingPipeline(
    store,
    PluginRegistry.createWithDefaults(),
    TraceMcpConfigSchema.parse({ exclude: ['**/vendor/**'] }),
    workDir,
  );
});

afterEach(async () => {
  await pipeline.dispose?.();
  try {
    db.close();
  } catch {
    /* best-effort */
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('indexFiles with nothing indexable', () => {
  it('reports an empty run instead of walking the pipeline', async () => {
    await pipeline.indexAll();
    const before = store.getStats();

    const r = await pipeline.indexFiles([join(workDir, 'vendor', 'dep.ts')]);

    expect(r.totalFiles).toBe(0);
    expect(r.indexed).toBe(0);
    expect(r.errors).toBe(0);
    expect(store.getStats().totalSymbols).toBe(before.totalSymbols);
  });

  it('does not queue behind an indexing pass already holding the lock', async () => {
    await pipeline.indexAll();

    let fullFinished = false;
    const full = pipeline.indexAll().then((res) => {
      fullFinished = true;
      return res;
    });

    const r = await pipeline.indexFiles([join(workDir, 'vendor', 'dep.ts')]);

    // The whole point: the no-op answered while the full pass was still
    // running. Without the pre-lock guard this await resolves only after
    // `full` does, and the event's telemetry reports that wait as its own
    // reindex latency.
    expect(fullFinished).toBe(false);
    expect(r.totalFiles).toBe(0);

    await full;
  });
});
