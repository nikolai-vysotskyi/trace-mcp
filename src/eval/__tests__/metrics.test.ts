import { describe, expect, it } from 'vitest';
import { precisionAtK } from '../metrics/precision-at-k.js';
import { reciprocalRank } from '../metrics/mrr.js';
import type { CaseResultItem } from '../types.js';

function item(rank: number, file: string): CaseResultItem {
  return {
    rank,
    symbol_id: `${file}::sym${rank}#function`,
    name: `sym${rank}`,
    kind: 'function',
    file,
    score: 1 / rank,
  };
}

describe('precisionAtK', () => {
  it('returns 1/k when the only expected file is the top result', () => {
    const results = [item(1, 'src/a.ts'), item(2, 'src/b.ts'), item(3, 'src/c.ts')];
    const m = precisionAtK({ results, expected_files: ['src/a.ts'], k: 3 });
    expect(m.value).toBeCloseTo(1 / 3, 6);
    expect(m.details).toEqual({ matched: 1, k: 3 });
  });

  it('caps matched at the size of the expected set (no double-counting)', () => {
    // src/a.ts appears twice in top-K; precision must still be 1/k, not 2/k.
    const results = [item(1, 'src/a.ts'), item(2, 'src/a.ts'), item(3, 'src/c.ts')];
    const m = precisionAtK({ results, expected_files: ['src/a.ts'], k: 3 });
    expect(m.value).toBeCloseTo(1 / 3, 6);
  });

  it('returns 0 when no expected file is in top-K', () => {
    const results = [item(1, 'src/x.ts'), item(2, 'src/y.ts')];
    const m = precisionAtK({
      results,
      expected_files: ['src/never.ts'],
      k: 5,
    });
    expect(m.value).toBe(0);
  });

  it('only considers the first K results', () => {
    // Expected file sits at rank 4 — outside top-K=3.
    const results = [
      item(1, 'src/x.ts'),
      item(2, 'src/y.ts'),
      item(3, 'src/z.ts'),
      item(4, 'src/target.ts'),
    ];
    const m = precisionAtK({
      results,
      expected_files: ['src/target.ts'],
      k: 3,
    });
    expect(m.value).toBe(0);
  });

  it('returns 0 with details.reason when k <= 0', () => {
    const m = precisionAtK({ results: [], expected_files: ['x'], k: 0 });
    expect(m.value).toBe(0);
    expect(m.details).toMatchObject({ reason: expect.any(String) });
  });
});

describe('reciprocalRank', () => {
  it('returns 1 when the top result is expected', () => {
    const results = [item(1, 'src/a.ts'), item(2, 'src/b.ts')];
    const rr = reciprocalRank({ results, expected_files: ['src/a.ts'] });
    expect(rr.value).toBe(1);
    expect(rr.first_hit_rank).toBe(1);
  });

  it('returns 1/N when the expected file is at rank N', () => {
    const results = [
      item(1, 'src/x.ts'),
      item(2, 'src/y.ts'),
      item(3, 'src/target.ts'),
      item(4, 'src/z.ts'),
    ];
    const rr = reciprocalRank({ results, expected_files: ['src/target.ts'] });
    expect(rr.value).toBeCloseTo(1 / 3, 6);
    expect(rr.first_hit_rank).toBe(3);
  });

  it('returns 0 when no expected file appears in results', () => {
    const results = [item(1, 'src/x.ts'), item(2, 'src/y.ts')];
    const rr = reciprocalRank({ results, expected_files: ['src/missing.ts'] });
    expect(rr.value).toBe(0);
    expect(rr.first_hit_rank).toBeNull();
  });

  it('counts the first match when multiple expected files are present', () => {
    const results = [item(1, 'src/other.ts'), item(2, 'src/second.ts'), item(3, 'src/first.ts')];
    // Both "first.ts" and "second.ts" are expected; the earlier rank wins.
    const rr = reciprocalRank({
      results,
      expected_files: ['src/first.ts', 'src/second.ts'],
    });
    expect(rr.first_hit_rank).toBe(2);
    expect(rr.value).toBeCloseTo(1 / 2, 6);
  });
});
