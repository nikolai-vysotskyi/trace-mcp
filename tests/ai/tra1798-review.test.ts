import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { EmbeddingPipeline, readEmbeddingBreakerState } from '../../src/ai/embedding-pipeline.js';
import { OpenAIProvider } from '../../src/ai/openai.js';
import { BlobVectorStore } from '../../src/ai/vector-store.js';
import { ProgressState } from '../../src/progress.js';
import { isHostUnreachableError } from '../../src/utils/retry.js';
import type { Store } from '../../src/db/store.js';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT, fqn TEXT, kind TEXT, signature TEXT, summary TEXT);
    CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO symbols (id,name,kind) VALUES (1,'hello','function');`);
  const store = {
    db,
    countUnembeddedSymbols: () =>
      (
        db
          .prepare(
            'SELECT COUNT(*) AS c FROM symbols s LEFT JOIN symbol_embeddings se ON se.symbol_id=s.id WHERE se.symbol_id IS NULL',
          )
          .get() as { c: number }
      ).c,
  } as Store;
  const provider = new OpenAIProvider({
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'test',
    embeddingModel: 'test',
    embeddingDimensions: 4,
    inferenceModel: 'test',
    fastModel: 'test',
  });
  const progress = new ProgressState();
  const pipeline = new EmbeddingPipeline(
    store,
    provider.embedding(),
    new BlobVectorStore(db),
    progress,
  );
  return { db, pipeline, progress };
}

function success() {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }] }), {
    status: 200,
  });
}

it('retries an HTTP 503 from a reachable gateway even when its body mentions ECONNREFUSED', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('upstream connect ECONNREFUSED 127.0.0.1:8000', {
        status: 503,
        statusText: 'Service Unavailable',
      }),
    )
    .mockResolvedValueOnce(success());
  vi.stubGlobal('fetch', fetch);
  const { db, pipeline, progress } = setup();
  try {
    const indexed = await pipeline.indexUnembedded();
    expect({
      indexed,
      calls: fetch.mock.calls.length,
      phase: progress.snapshot().embedding.phase,
    }).toEqual({ indexed: 1, calls: 2, phase: 'completed' });
  } finally {
    db.close();
  }
});

it('does not classify a mixed IPv6-unreachable / IPv4-timeout aggregate as a dead endpoint', () => {
  const error = new TypeError('fetch failed', {
    cause: new AggregateError([
      Object.assign(new Error('connect ENETUNREACH ::1'), { code: 'ENETUNREACH' }),
      Object.assign(new Error('connect ETIMEDOUT 127.0.0.1'), { code: 'ETIMEDOUT' }),
    ]),
  });
  expect(isHostUnreachableError(error)).toBe(false);
});

it('recovers immediately through resetCircuitBreaker with real progress and persisted state', async () => {
  const refused = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
  const fetch = vi.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce(success());
  vi.stubGlobal('fetch', fetch);
  const { db, pipeline, progress } = setup();
  try {
    expect(await pipeline.indexUnembedded()).toBe(0);
    expect(progress.snapshot().embedding.phase).toBe('skipped');
    expect(readEmbeddingBreakerState(db)?.disabledUntilMs).toBeGreaterThan(Date.now());
    pipeline.resetCircuitBreaker();
    expect(await pipeline.indexUnembedded()).toBe(1);
    expect(progress.snapshot().embedding.phase).toBe('completed');
    expect(readEmbeddingBreakerState(db)).toBeNull();
  } finally {
    db.close();
  }
});
