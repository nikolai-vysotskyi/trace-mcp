import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingPipeline, readEmbeddingBreakerState } from '../embedding-pipeline.js';
import type { EmbeddingService } from '../interfaces.js';
import { BlobVectorStore } from '../vector-store.js';

/**
 * TRA-812: with the embedding endpoint down (`lmstudio` configured, LM Studio
 * not running) the daemon re-announced the same 3 445-symbol backlog 36 times
 * in 40 hours and logged each total failure as `embedding completed: 0 items`.
 * Two causes: the circuit breaker lived only in process memory, and a run where
 * every batch failed still reported phase 'completed'.
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

/** Minimal DB with the tables the pipeline and the breaker state touch. */
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

/** Reproduces the field condition: every embedBatch call throws `fetch failed`. */
function unreachableService(): EmbeddingService & { calls: number } {
  const svc = {
    calls: 0,
    async embed() {
      throw new TypeError('fetch failed');
    },
    async embedBatch(): Promise<number[][]> {
      svc.calls++;
      throw new TypeError('fetch failed');
    },
    dimensions: () => 768,
    modelName: () => 'nomic-embed-text-v1.5',
    providerName: () => 'openai',
  };
  return svc;
}

function workingService(dim = 4): EmbeddingService {
  return {
    async embed() {
      return Array.from({ length: dim }, () => 0.1);
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => Array.from({ length: dim }, () => 0.1));
    },
    dimensions: () => dim,
    modelName: () => 'nomic-embed-text-v1.5',
    providerName: () => 'openai',
  };
}

describe('embedding circuit breaker survives a daemon restart', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    errorSpy.mockClear();
    infoSpy.mockClear();
  });

  it('persists the cooldown and skips the whole backlog in the next process', async () => {
    const db = seedDb(10);
    const store = fakeStore(db);

    // A run bails out at its first failed batch, so one run == one failure.
    // Each `new EmbeddingPipeline` here stands for a fresh daemon process
    // against the same project DB.
    const first = new EmbeddingPipeline(store, unreachableService(), new BlobVectorStore(db));
    expect(await first.indexUnembedded(5)).toBe(0);
    expect(first.getLastRunDiagnostics().breakerTripped).toBe(false);
    // The failure count carries over — otherwise a restart loop resets it every
    // few minutes and the threshold is never reached.
    expect(readEmbeddingBreakerState(db)!.consecutiveFailures).toBe(1);

    const second = new EmbeddingPipeline(store, unreachableService(), new BlobVectorStore(db));
    expect(await second.indexUnembedded(5)).toBe(0);
    expect(second.getLastRunDiagnostics().breakerTripped).toBe(true);

    const persisted = readEmbeddingBreakerState(db);
    expect(persisted!.disabledUntilMs).toBeGreaterThan(Date.now());
    expect(persisted!.lastError).toMatch(/fetch failed/);

    const svc = unreachableService();
    const third = new EmbeddingPipeline(store, svc, new BlobVectorStore(db));
    expect(await third.indexUnembedded(5)).toBe(0);
    // The point of the fix: not one further call against the dead endpoint.
    expect(svc.calls).toBe(0);
    // …and it says so instead of going quiet.
    expect(infoSpy.mock.calls.some(([, msg]) => /Embedding paused/.test(String(msg)))).toBe(true);
  });

  it('reports a run where every batch failed as an error, not "completed: 0 items"', async () => {
    const db = seedDb(4);
    const phases: string[] = [];
    const progress = {
      update(_name: string, partial: { phase?: string }) {
        if (partial.phase) phases.push(partial.phase);
      },
    } as unknown as import('../../progress.js').ProgressState;

    const pipeline = new EmbeddingPipeline(
      fakeStore(db),
      unreachableService(),
      new BlobVectorStore(db),
      progress,
    );
    expect(await pipeline.indexUnembedded(2)).toBe(0);
    expect(phases).toContain('error');
    expect(phases).not.toContain('completed');
  });

  it('clears the persisted breaker once a batch succeeds again', async () => {
    const db = seedDb(3);
    const store = fakeStore(db);

    const failing = new EmbeddingPipeline(store, unreachableService(), new BlobVectorStore(db));
    await failing.indexUnembedded(3);
    expect(readEmbeddingBreakerState(db)).not.toBeNull();

    // Explicit user action (embed_repo) must not be a no-op during the cooldown.
    const recovered = new EmbeddingPipeline(store, workingService(), new BlobVectorStore(db));
    recovered.resetCircuitBreaker();
    expect(await recovered.indexUnembedded(3)).toBe(3);
    expect(readEmbeddingBreakerState(db)).toBeNull();
  });
});
