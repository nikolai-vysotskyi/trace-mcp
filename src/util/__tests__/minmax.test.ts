import { describe, expect, it } from 'vitest';
import { minMax } from '../minmax.js';

describe('minMax', () => {
  it('matches Math.min/Math.max on a small array', () => {
    const xs = [3, -1, 7, 0, 7];
    expect(minMax(xs)).toEqual({ min: Math.min(...xs), max: Math.max(...xs) });
  });

  it('returns infinities for an empty array, so a caller must guard', () => {
    expect(minMax([])).toEqual({
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    });
  });

  // The regression: #957 reported `search` returning the bare string
  // "Maximum call stack size exceeded" for every query against a 152 734-symbol
  // index. `Math.min(...xs)` throws RangeError past V8's argument limit; the
  // ranking path built that array from the whole FTS result set, which is
  // bounded by the index rather than by the caller's `limit`.
  it('survives an array larger than V8 will accept as arguments', () => {
    const xs = Array.from({ length: 200_000 }, (_, i) => i % 977);
    expect(() => Math.min(...xs)).toThrow(RangeError);
    expect(minMax(xs)).toEqual({ min: 0, max: 976 });
  });
});
