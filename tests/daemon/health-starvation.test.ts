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

/** Event-loop stall observed while `run()` is in flight, in ms. This is what a
 *  pending /health request waits for: the handler itself is a constant-time
 *  JSON reply, so its latency IS the loop delay.
 *
 *  Both statistics are returned because they behave differently on a shared
 *  runner. `max` is a single sample, so anything that preempts the process once
 *  — another job on the box, a GC pause, the VM's own scheduler — lands in it
 *  whole. With this fix in place, `max` over the 10-project run measured 25 ms
 *  locally and 176-181 ms on GitHub's macOS and Windows runners for the same
 *  code, while `p99` stayed inside its band. Comparisons across arms therefore
 *  use `p99`; `max` is kept for the synthetic primitive test, where the run is
 *  two seconds of pure spin and there is nothing for noise to hide behind. */
async function loopDelayDuring(run: () => Promise<unknown>): Promise<{ max: number; p99: number }> {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  await run();
  h.disable();
  return { max: h.max / 1e6, p99: h.percentile(99) / 1e6 };
}

describe('runInOwnTurn keeps the stall window flat as concurrency grows', () => {
  const UNIT_MS = 30;
  const UNITS = 12;

  async function worker(): Promise<void> {
    for (let i = 0; i < UNITS; i++) await runInOwnTurn(() => spin(UNIT_MS));
  }

  it('one indexer: the window is one unit', async () => {
    const { max } = await loopDelayDuring(() => worker());
    expect(max).toBeLessThan(UNIT_MS * 3);
  }, 30_000);

  it('eight indexers: the window is still one unit, not eight', async () => {
    const { max } = await loopDelayDuring(() =>
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

  async function delayIndexing(
    dbName: string,
    mode: 'concurrent' | 'sequential',
  ): Promise<{ max: number; p99: number }> {
    const pipelines = roots.map((r) => makePipeline(r, dbName));
    try {
      return await loopDelayDuring(async () => {
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
    const sequential = await delayIndexing('seq.db', 'sequential');
    const concurrent = await delayIndexing('conc.db', 'concurrent');
    console.log(
      `loop delay p99: sequential=${sequential.p99.toFixed(1)}ms concurrent=${concurrent.p99.toFixed(1)}ms ` +
        `(max: ${sequential.max.toFixed(1)}ms / ${concurrent.max.toFixed(1)}ms)`,
    );
    // 3x, not 2x, and on p99 rather than max. Measured with the fairness chain
    // disabled, concurrent p99 is 4x sequential (107 ms vs 27 ms) and max is
    // 5-7x; with it, concurrent p99 sits at or below sequential (24 ms vs
    // 28 ms). The bound therefore sits in a wide empty gap. It was 2x on max,
    // which put it inside the runner's own jitter: both macOS and Windows CI
    // failed the case at 2.1x on the very commit that introduced it, with
    // sequential itself three times its local value.
    expect(concurrent.p99).toBeLessThan(sequential.p99 * 3);
  }, 300_000);
});
