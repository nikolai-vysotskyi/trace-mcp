import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingPipeline, readEmbeddingBreakerState } from '../embedding-pipeline.js';
import type { EmbeddingService } from '../interfaces.js';
import { BlobVectorStore } from '../vector-store.js';

/**
 * TRA-1798: with LM Studio down, every daemon start logged the same 4-line
 * packet — 2× L40 retry warns, L50 "Embedding batch failed" with a stack, and
 * L50 "embedding failed" from the progress tracker — for an expected
 * environment state. The pipeline must instead emit exactly one warn summary
 * per process (naming the FTS-only degradation), trip the breaker at once,
 * and report the run as 'skipped'. L50 stays reserved for a provider that
 * dies mid-service, after successful batches.
 */

const {
  warn: warnSpy,
  error: errorSpy,
  info: infoSpy,
} = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { warn: warnSpy, error: errorSpy, info: infoSpy, debug: vi.fn() },
}));

/** Realistic undici shape for `fetch(http://localhost:1234/…)` with nothing listening. */
function refusedError(): TypeError {
  const conn = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), {
    code: 'ECONNREFUSED',
  });
  const aggregate = Object.assign(new AggregateError([conn], 'fetch failed'), {
    code: 'ECONNREFUSED',
  });
  return new TypeError('fetch failed', { cause: aggregate });
}

function seedDb(symbolCount: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY,
      name TEXT, fqn TEXT, kind TEXT, signature TEXT, summary TEXT
    );
    CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const ins = db.prepare('INSERT INTO symbols (id, name, kind) VALUES (?, ?, ?)');
  for (let i = 1; i <= symbolCount; i++) ins.run(i, `sym${i}`, 'function');
  return db;
}

function fakeStore(db: Database.Database) {
  return {
    db,
    countUnembeddedSymbols(): number {
      const row = db
        .prepare(
          'SELECT COUNT(*) AS c FROM symbols s LEFT JOIN symbol_embeddings se ON se.symbol_id = s.id WHERE se.symbol_id IS NULL',
        )
        .get() as { c: number };
      return row.c;
    },
  } as unknown as import('../../db/store.js').Store;
}

/** Never reachable: every embedBatch throws ECONNREFUSED (LM Studio down). */
function refusedService(): EmbeddingService & { calls: number } {
  const svc = {
    calls: 0,
    async embed(): Promise<number[]> {
      throw refusedError();
    },
    async embedBatch(): Promise<number[][]> {
      svc.calls++;
      throw refusedError();
    },
    dimensions: () => 768,
    modelName: () => 'nomic-embed-text-v1.5',
    providerName: () => 'openai',
  };
  return svc;
}

function phaseCollector() {
  const phases: string[] = [];
  const progress = {
    update(_name: string, partial: { phase?: string }) {
      if (partial.phase) phases.push(partial.phase);
    },
  } as unknown as import('../../progress.js').ProgressState;
  return { phases, progress };
}

describe('unreachable embedding provider from daemon start (TRA-1798)', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    errorSpy.mockClear();
    infoSpy.mockClear();
  });

  it('logs one warn summary, no L50, trips the breaker on the first failure', async () => {
    const db = seedDb(4);
    const svc = refusedService();
    const { phases, progress } = phaseCollector();
    const pipeline = new EmbeddingPipeline(fakeStore(db), svc, new BlobVectorStore(db), progress);

    expect(await pipeline.indexUnembedded(2)).toBe(0);
    // Fail fast: no retry storm against the dead endpoint.
    expect(svc.calls).toBe(1);

    // Exactly one warn naming the FTS-only degradation…
    const ftsWarns = warnSpy.mock.calls.filter(([, msg]) => /FTS-only/.test(String(msg)));
    expect(ftsWarns).toHaveLength(1);
    expect(String(ftsWarns[0][1])).toMatch(/Embeddings unavailable/);
    expect(ftsWarns[0][0]).toMatchObject({ reason: 'ECONNREFUSED', queued: 4 });
    // …and no error-level log at all (no "Embedding batch failed", no stack).
    expect(errorSpy).not.toHaveBeenCalled();

    // The breaker trips immediately — a restart loop must not re-probe either.
    const diag = pipeline.getLastRunDiagnostics();
    expect(diag.failedBatches).toBe(1);
    expect(diag.breakerTripped).toBe(true);
    expect(diag.lastError).toMatch(/fetch failed/);
    const persisted = readEmbeddingBreakerState(db);
    expect(persisted!.disabledUntilMs).toBeGreaterThan(Date.now());

    // The run reports 'skipped' so the progress tracker stays quiet too.
    expect(phases).toContain('skipped');
    expect(phases).not.toContain('error');
  });

  it('stays silent on later triggers in the same process and the next process', async () => {
    const db = seedDb(4);
    const svc = refusedService();
    const pipeline = new EmbeddingPipeline(fakeStore(db), svc, new BlobVectorStore(db));
    await pipeline.indexUnembedded(2);

    // Same process, cooldown open: no further provider calls, no further warns.
    await pipeline.indexUnembedded(2);
    expect(svc.calls).toBe(1);
    expect(warnSpy.mock.calls.filter(([, msg]) => /FTS-only/.test(String(msg)))).toHaveLength(1);

    // Next process (fresh pipeline, same DB): still silent, still no calls.
    const svc2 = refusedService();
    const next = new EmbeddingPipeline(fakeStore(db), svc2, new BlobVectorStore(db));
    expect(await next.indexUnembedded(2)).toBe(0);
    expect(svc2.calls).toBe(0);
    expect(warnSpy.mock.calls.filter(([, msg]) => /FTS-only/.test(String(msg)))).toHaveLength(1);
  });

  it('keeps L50 when the provider dies after successful batches', async () => {
    const db = seedDb(4);
    let calls = 0;
    const flaky: EmbeddingService = {
      async embed(): Promise<number[]> {
        return [0.1, 0.2, 0.3, 0.4];
      },
      async embedBatch(texts: string[]) {
        calls++;
        // First batch succeeds, then the provider dies mid-run.
        if (calls === 1) return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
        throw refusedError();
      },
      dimensions: () => 4,
      modelName: () => 'nomic-embed-text-v1.5',
      providerName: () => 'openai',
    };
    const { phases, progress } = phaseCollector();
    const pipeline = new EmbeddingPipeline(fakeStore(db), flaky, new BlobVectorStore(db), progress);

    expect(await pipeline.indexUnembedded(2)).toBe(2);
    // Mid-service death is a real regression: L50 with the error object…
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][1])).toMatch(/Embedding batch failed/);
    // …while the run itself reports the partial progress as completed (2 of
    // 4 embedded before the death), not 'skipped'.
    expect(phases).toContain('completed');
    expect(phases).not.toContain('skipped');
  });

  it('keeps the loud path for ambiguous failures without code info', async () => {
    const db = seedDb(2);
    const ambiguous: EmbeddingService = {
      async embed(): Promise<number[]> {
        throw new TypeError('fetch failed');
      },
      async embedBatch(): Promise<number[][]> {
        throw new TypeError('fetch failed');
      },
      dimensions: () => 4,
      modelName: () => 'nomic-embed-text-v1.5',
      providerName: () => 'openai',
    };
    const { phases, progress } = phaseCollector();
    const pipeline = new EmbeddingPipeline(
      fakeStore(db),
      ambiguous,
      new BlobVectorStore(db),
      progress,
    );

    expect(await pipeline.indexUnembedded(2)).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
    expect(phases).toContain('error');
  });
});
