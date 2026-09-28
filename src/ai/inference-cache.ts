/**
 * Content-addressable inference cache backed by SQLite.
 * Key = sha256(model + '\0' + maxTokens + '\0' + prompt) → cached response.
 * The output budget is part of the key because the response depends on it: a
 * summary cached at maxTokens=100 must not be served for a call at 1024
 * (GH#1423 — otherwise raising `ai.summarize_max_tokens` looks like a no-op
 * for everything already cached). An omitted budget keeps the legacy
 * model+prompt key so budget-less callers still hit pre-existing entries.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { logger } from '../logger.js';

export class InferenceCache {
  constructor(private db: Database.Database) {}

  private cacheKey(model: string, prompt: string, maxTokens?: number): string {
    // Genuinely the legacy key when no budget is passed (not the budgeted
    // shape with an empty segment): entries written before the budget existed
    // must stay readable, or the first index after the upgrade re-bills every
    // cached call.
    if (maxTokens == null) {
      return createHash('sha256').update(`${model}\0${prompt}`).digest('hex');
    }
    return createHash('sha256').update(`${model}\0${maxTokens}\0${prompt}`).digest('hex');
  }

  get(model: string, prompt: string, maxTokens?: number): string | null {
    const key = this.cacheKey(model, prompt, maxTokens);
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

  set(model: string, prompt: string, response: string, maxTokens?: number): void {
    const key = this.cacheKey(model, prompt, maxTokens);
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
