/**
 * Content-addressable inference cache backed by SQLite.
 * Key = sha256(model + '\0' + prompt) → cached response.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';

export class InferenceCache {
  constructor(private db: Database.Database) {}

  private cacheKey(model: string, prompt: string): string {
    return createHash('sha256')
      .update(model + '\0' + prompt)
      .digest('hex');
  }

  get(model: string, prompt: string): string | null {
    const key = this.cacheKey(model, prompt);
    const row = this.db
      .prepare(
        `SELECT response FROM inference_cache
       WHERE cache_key = ?
         AND datetime(created_at, '+' || ttl_days || ' days') > datetime('now')`,
      )
      .get(key) as { response: string } | undefined;
    if (row) {
      logger.debug({ model, cacheKey: key.slice(0, 12) }, 'Inference cache hit');
    }
    return row?.response ?? null;
  }

  set(model: string, prompt: string, response: string): void {
    const key = this.cacheKey(model, prompt);
    const promptHash = createHash('sha256').update(prompt).digest('hex');
    this.db
      .prepare(
        `INSERT OR REPLACE INTO inference_cache (cache_key, model, prompt_hash, response, created_at, ttl_days)
       VALUES (?, ?, ?, ?, datetime('now'), 90)`,
      )
      .run(key, model, promptHash, response);
  }

  evictExpired(): number {
    const result = this.db
      .prepare(
        `DELETE FROM inference_cache
       WHERE datetime(created_at, '+' || ttl_days || ' days') <= datetime('now')`,
      )
      .run();
    const count = result.changes;
    if (count > 0) {
      logger.info({ evicted: count }, 'Evicted expired inference cache entries');
    }
    return count;
  }
}
