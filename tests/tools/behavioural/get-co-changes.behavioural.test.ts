/**
 * Behavioural coverage for `getCoChanges()` in
 * `src/tools/quality/co-changes.ts` (the implementation behind the
 * `get_co_changes` MCP tool). Seeds the `co_changes` table directly so we
 * can verify the query layer without spinning up a real git repo.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getCoChanges } from '../../../src/tools/quality/co-changes.js';
import { createTestStore } from '../../test-utils.js';

function seedCoChange(
  store: Store,
  a: string,
  b: string,
  opts: {
    count: number;
    totalA: number;
    totalB: number;
    confidence: number;
    lastDate?: string;
    windowDays?: number;
  },
): void {
  store.db
    .prepare(`
      INSERT OR REPLACE INTO co_changes
        (file_a, file_b, co_change_count, total_changes_a, total_changes_b,
         confidence, last_co_change, window_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      a,
      b,
      opts.count,
      opts.totalA,
      opts.totalB,
      opts.confidence,
      opts.lastDate ?? '2026-01-15T10:00:00Z',
      opts.windowDays ?? 180,
    );
}

describe('getCoChanges() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns co-changed files for a queried file with correct shape', () => {
    seedCoChange(store, 'src/auth.ts', 'src/session.ts', {
      count: 10,
      totalA: 12,
      totalB: 14,
      confidence: 0.8,
    });
    seedCoChange(store, 'src/auth.ts', 'src/middleware.ts', {
      count: 6,
      totalA: 12,
      totalB: 8,
      confidence: 0.5,
    });

    const result = getCoChanges(store, { file: 'src/auth.ts' });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.file).toBe('src/auth.ts');
    expect(value.coChanges.length).toBe(2);
    // Sorted by confidence desc → session.ts (0.8) before middleware.ts (0.5).
    expect(value.coChanges[0].file).toBe('src/session.ts');
    expect(value.coChanges[0].confidence).toBeCloseTo(0.8, 5);
    expect(value.coChanges[0].count).toBe(10);
    expect(value.coChanges[1].file).toBe('src/middleware.ts');
  });

  it('min_confidence filter excludes low-confidence pairs', () => {
    seedCoChange(store, 'src/auth.ts', 'src/strong.ts', {
      count: 10,
      totalA: 12,
      totalB: 12,
      confidence: 0.85,
    });
    seedCoChange(store, 'src/auth.ts', 'src/weak.ts', {
      count: 5,
      totalA: 12,
      totalB: 50,
      confidence: 0.1,
    });

    const result = getCoChanges(store, { file: 'src/auth.ts', minConfidence: 0.5 });
    expect(result.isOk()).toBe(true);
    const files = result._unsafeUnwrap().coChanges.map((c) => c.file);
    expect(files).toEqual(['src/strong.ts']);
  });

  it('min_count filter excludes low-co-change-count pairs', () => {
    seedCoChange(store, 'src/auth.ts', 'src/heavy.ts', {
      count: 10,
      totalA: 12,
      totalB: 12,
      confidence: 0.9,
    });
    seedCoChange(store, 'src/auth.ts', 'src/light.ts', {
      count: 2,
      totalA: 12,
      totalB: 4,
      confidence: 0.5,
    });

    const result = getCoChanges(store, { file: 'src/auth.ts', minCount: 5 });
    expect(result.isOk()).toBe(true);
    const files = result._unsafeUnwrap().coChanges.map((c) => c.file);
    expect(files).toEqual(['src/heavy.ts']);
  });

  it('limit caps the number of returned co-changes', () => {
    for (let i = 0; i < 5; i++) {
      seedCoChange(store, 'src/auth.ts', `src/peer${i}.ts`, {
        count: 10 - i,
        totalA: 20,
        totalB: 20,
        confidence: 0.9 - i * 0.05,
      });
    }

    const result = getCoChanges(store, { file: 'src/auth.ts', limit: 2 });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.coChanges.length).toBe(2);
    // Top-ranked entries by confidence desc.
    expect(value.coChanges[0].file).toBe('src/peer0.ts');
    expect(value.coChanges[1].file).toBe('src/peer1.ts');
  });

  it('unknown file returns an empty co-changes list', () => {
    seedCoChange(store, 'src/known.ts', 'src/partner.ts', {
      count: 5,
      totalA: 5,
      totalB: 5,
      confidence: 1.0,
    });

    const result = getCoChanges(store, { file: 'src/ghost.ts' });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.file).toBe('src/ghost.ts');
    expect(value.coChanges).toEqual([]);
  });

  it('finds the queried file regardless of which side of the pair it lives on', () => {
    // Seed pair as (a=peer, b=auth) — query must still find auth.ts -> peer.
    seedCoChange(store, 'src/peer.ts', 'src/auth.ts', {
      count: 7,
      totalA: 10,
      totalB: 10,
      confidence: 0.7,
    });

    const result = getCoChanges(store, { file: 'src/auth.ts' });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.coChanges.length).toBe(1);
    expect(value.coChanges[0].file).toBe('src/peer.ts');
    expect(value.coChanges[0].count).toBe(7);
  });
});
