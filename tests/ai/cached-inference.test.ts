import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { InferenceService } from '../../src/ai/interfaces.js';
import { InferenceCache } from '../../src/ai/inference-cache.js';
import { CachedInferenceService } from '../../src/ai/cached-inference.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE inference_cache (
      cache_key   TEXT PRIMARY KEY,
      model       TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      response    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      ttl_days    INTEGER DEFAULT 90
    );
  `);
  return db;
}

function createMockInference(): InferenceService & { generate: ReturnType<typeof vi.fn> } {
  return {
    generate: vi.fn(async () => 'generated-response'),
  };
}

describe('CachedInferenceService', () => {
  it('calls inner service on cache miss and caches result', async () => {
    const db = createDb();
    const cache = new InferenceCache(db);
    const inner = createMockInference();
    const service = new CachedInferenceService(inner, cache, 'test-model');

    const result = await service.generate('test prompt');
    expect(result).toBe('generated-response');
    expect(inner.generate).toHaveBeenCalledOnce();

    // Second call should hit cache
    const result2 = await service.generate('test prompt');
    expect(result2).toBe('generated-response');
    expect(inner.generate).toHaveBeenCalledOnce(); // still 1 call
  });

  it('does not cache empty responses', async () => {
    const db = createDb();
    const cache = new InferenceCache(db);
    const inner: InferenceService & { generate: ReturnType<typeof vi.fn> } = {
      generate: vi.fn(async () => ''),
    };
    const service = new CachedInferenceService(inner, cache, 'test-model');

    await service.generate('test prompt');
    await service.generate('test prompt');
    expect(inner.generate).toHaveBeenCalledTimes(2);
  });

  it('passes options through to inner service', async () => {
    const db = createDb();
    const cache = new InferenceCache(db);
    const inner = createMockInference();
    const service = new CachedInferenceService(inner, cache, 'test-model');

    await service.generate('test', { maxTokens: 100, temperature: 0.1 });
    expect(inner.generate).toHaveBeenCalledWith('test', { maxTokens: 100, temperature: 0.1 });
  });
});
