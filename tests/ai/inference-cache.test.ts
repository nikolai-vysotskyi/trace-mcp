import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { InferenceCache } from '../../src/ai/inference-cache.js';

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
    CREATE INDEX idx_inference_cache_model ON inference_cache(model);
  `);
  return db;
}

describe('InferenceCache', () => {
  let db: Database.Database;
  let cache: InferenceCache;

  beforeEach(() => {
    db = createDb();
    cache = new InferenceCache(db);
  });

  it('returns null on cache miss', () => {
    expect(cache.get('model-a', 'prompt-1')).toBeNull();
  });

  it('returns cached response on cache hit', () => {
    cache.set('model-a', 'prompt-1', 'response-1');
    expect(cache.get('model-a', 'prompt-1')).toBe('response-1');
  });

  it('different models produce different cache keys', () => {
    cache.set('model-a', 'prompt-1', 'response-a');
    cache.set('model-b', 'prompt-1', 'response-b');
    expect(cache.get('model-a', 'prompt-1')).toBe('response-a');
    expect(cache.get('model-b', 'prompt-1')).toBe('response-b');
  });

  it('overwrites existing entry on same key', () => {
    cache.set('model-a', 'prompt-1', 'old');
    cache.set('model-a', 'prompt-1', 'new');
    expect(cache.get('model-a', 'prompt-1')).toBe('new');
  });

  it('evictExpired removes expired entries', () => {
    cache.set('model-a', 'expired-prompt', 'response');
    // Manually set created_at to 100 days ago
    db.prepare(
      `UPDATE inference_cache SET created_at = datetime('now', '-100 days')`,
    ).run();
    const evicted = cache.evictExpired();
    expect(evicted).toBe(1);
    expect(cache.get('model-a', 'expired-prompt')).toBeNull();
  });

  it('evictExpired keeps fresh entries', () => {
    cache.set('model-a', 'fresh-prompt', 'response');
    const evicted = cache.evictExpired();
    expect(evicted).toBe(0);
    expect(cache.get('model-a', 'fresh-prompt')).toBe('response');
  });
});
