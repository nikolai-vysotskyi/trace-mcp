import { describe, expect, it } from 'vitest';
import { addSpan, covers, median, percentile, type Spans } from '../../scripts/bench-pr-context.js';

describe('bench-pr-context scoring helpers', () => {
  it('covers only lines inside a recorded span', () => {
    const spans: Spans = new Map();
    addSpan(spans, 'src/a.ts', 10, 20);
    expect(covers(spans, 'src/a.ts', 10)).toBe(true);
    expect(covers(spans, 'src/a.ts', 20)).toBe(true);
    expect(covers(spans, 'src/a.ts', 9)).toBe(false);
    expect(covers(spans, 'src/a.ts', 21)).toBe(false);
    expect(covers(spans, 'src/b.ts', 15)).toBe(false);
  });

  it('normalises path separators so Windows-style paths still match', () => {
    const spans: Spans = new Map();
    addSpan(spans, 'src\\a.ts', 1, 5);
    expect(covers(spans, 'src/a.ts', 3)).toBe(true);
  });

  it('unions multiple spans in the same file', () => {
    const spans: Spans = new Map();
    addSpan(spans, 'src/a.ts', 1, 5);
    addSpan(spans, 'src/a.ts', 30, 40);
    expect(covers(spans, 'src/a.ts', 3)).toBe(true);
    expect(covers(spans, 'src/a.ts', 35)).toBe(true);
    expect(covers(spans, 'src/a.ts', 12)).toBe(false);
  });

  it('computes median for odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('computes p90 as a real order statistic', () => {
    const xs = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10
    expect(percentile(xs, 90)).toBe(9);
    expect(percentile(xs, 100)).toBe(10);
    expect(percentile([], 90)).toBe(0);
  });
});
