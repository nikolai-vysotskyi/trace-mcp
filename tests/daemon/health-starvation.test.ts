/**
 * TRA-1127 — /health must stay answerable while the daemon indexes.
 *
 * The field report: the production daemon (21 projects loaded) did not answer
 * `/health` for over 5 s during a reindex burst, at 99% CPU, with 62% of main
 * thread samples inside synchronous `sqlite3_step`. A session that cannot reach
 * /health concludes the daemon is dead and starts its own full local index —
 * so a merely busy daemon manufactures N independent indexers, which makes it
 * busier. The failure amplifies itself.
 *
 * The mechanism is not "SQLite is synchronous" on its own. The indexing paths
 * already yield with `setImmediate` between chunks. But Node drains the whole
 * check-phase queue before returning to poll, so N concurrent indexers that
 * each yield still stack N chunks into a single turn: the window a pending
 * health request waits for is the SUM of every project's chunk, not the
 * largest one. Measured on a bare HTTP server with 50 ms chunks, p50 request
 * latency was 100 ms at N=1 and 2 100 ms at N=21.
 *
 * These two tests guard the two halves of that: the primitive
 * (`runInOwnTurn`) under synthetic load, and real indexing of several projects
 * at once.
 *
 * The primitive test is the sharp one — it fails on any regression in the
 * fairness chain itself. The real-load test is coarser by construction: the
 * pipeline yields at several points, so breaking one of them can be masked by
 * the others on a small corpus. It is here to catch the wiring coming undone
 * wholesale, not to localise which yield was lost.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { runInOwnTurn } from '../../src/utils/event-loop.js';

/** Burn `ms` of CPU on the main thread — stands in for a persist transaction. */
function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* busy */
  }
}

/** Max event-loop stall observed while `run()` is in flight, in ms. This is
 *  what a pending /health request waits for: the handler itself is a constant
 *  -time JSON reply, so its latency IS the loop delay. */
async function maxLoopDelayDuring(run: () => Promise<unknown>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  await run();
  h.disable();
  return h.max / 1e6;
}

describe('runInOwnTurn keeps the stall window flat as concurrency grows', () => {
  const UNIT_MS = 30;
  const UNITS = 12;

  async function worker(): Promise<void> {
    for (let i = 0; i < UNITS; i++) await runInOwnTurn(() => spin(UNIT_MS));
  }

  it('one indexer: the window is one unit', async () => {
    const max = await maxLoopDelayDuring(() => worker());
    expect(max).toBeLessThan(UNIT_MS * 3);
  }, 30_000);

  it('eight indexers: the window is still one unit, not eight', async () => {
    const max = await maxLoopDelayDuring(() =>
      Promise.all(Array.from({ length: 8 }, () => worker())),
    );
    // Pre-fix this is ~8 x UNIT_MS (the whole check-phase queue drains before
    // poll). The bound below is deliberately far from both: it fails loudly on
    // a regression to summing behaviour and does not flake on a slow CI box.
    expect(max).toBeLessThan(UNIT_MS * 4);
  }, 30_000);
});

describe('real indexing load: many projects at once', () => {
  const PROJECTS = 10;
  const FILES = 400;
  let tmpRoot: string;
  const roots: string[] = [];

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1127-'));
    for (let p = 0; p < PROJECTS; p++) {
      const root = path.join(tmpRoot, `proj${p}`);
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      for (let f = 0; f < FILES; f++) {
        const prev = f === 0 ? '' : `import { fn${f - 1} } from './mod${f - 1}.js';\n`;
        fs.writeFileSync(
          path.join(root, 'src', `mod${f}.ts`),
          `${prev}export class Cls${f} { run(): number { return ${f}; } }\n` +
            `export function fn${f}(): number { return new Cls${f}().run(); }\n` +
            `export const CONST${f} = fn${f}();\n`,
        );
      }
      roots.push(root);
    }
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makePipeline(root: string, dbName: string): IndexingPipeline {
    const db = initializeDatabase(path.join(root, dbName));
    return new IndexingPipeline(
      new Store(db),
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({ root }),
      root,
    );
  }

  async function maxDelayIndexing(
    dbName: string,
    mode: 'concurrent' | 'sequential',
  ): Promise<number> {
    const pipelines = roots.map((r) => makePipeline(r, dbName));
    try {
      return await maxLoopDelayDuring(async () => {
        if (mode === 'concurrent') {
          await Promise.all(pipelines.map((p) => p.indexAll(false)));
        } else {
          for (const p of pipelines) await p.indexAll(false);
        }
      });
    } finally {
      for (const p of pipelines) await p.dispose();
    }
  }

  it(`indexing ${PROJECTS} projects at once stalls no longer than indexing one`, async () => {
    // Same corpus, same machine, back-to-back: indexing the projects one after
    // another gives the width of a single project's largest synchronous unit.
    // Doing all of them at once must not make that window wider — pre-fix it
    // grew with the project count, which is how a busy daemon stopped
    // answering /health for seconds at a time with 21 projects loaded.
    const sequential = await maxDelayIndexing('seq.db', 'sequential');
    const concurrent = await maxDelayIndexing('conc.db', 'concurrent');
    console.log(
      `max loop delay: sequential=${sequential.toFixed(1)}ms concurrent=${concurrent.toFixed(1)}ms`,
    );
    expect(concurrent).toBeLessThan(sequential * 2);
  }, 300_000);
});
