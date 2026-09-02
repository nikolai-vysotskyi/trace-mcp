import { describe, expect, it } from 'vitest';
import { activation, share } from '../../scripts/ga4-funnel.mjs';

/** One GA4 row: a `repos_indexed` value and how many active installs reported it. */
const row = (value: string, users: number) => ({
  dimensionValues: [{ value }],
  metricValues: [{ value: String(users) }],
});

describe('activation', () => {
  it('splits installs that indexed something from installs that never did', () => {
    const result = activation([row('0', 20), row('1', 5), row('3', 4), row('12', 1)]);

    expect(result).toMatchObject({
      not_activated: 20,
      activated: 10,
      activated_pct: 33,
      buckets: { '0': 20, '1': 5, '2-5': 4, '6+': 1 },
      unknown: 0,
    });
  });

  it('reports no data as null, not as a 0% activation rate', () => {
    // The distinction that matters: an unregistered GA4 dimension returns no
    // rows, and rounding that to "0% of installs activated" would be a lie.
    expect(activation([]).activated_pct).toBeNull();
    expect(activation(undefined).activated_pct).toBeNull();
  });

  it('keeps unplaceable values out of both sides of the split', () => {
    const result = activation([row('0', 3), row('(not set)', 7), row('', 2)]);

    expect(result.unknown).toBe(9);
    expect(result.not_activated).toBe(3);
    expect(result.activated).toBe(0);
    // 9 unknown installs must not be counted as 9 activation failures.
    expect(result.activated_pct).toBe(0);
  });

  it('ignores rows carrying no users', () => {
    expect(activation([row('4', 0), row('2', 6)])).toMatchObject({
      activated: 6,
      activated_pct: 100,
    });
  });
});

describe('share', () => {
  it('rounds to a whole percent', () => {
    expect(share(54, 61)).toBe(89);
  });

  it('returns null rather than dividing by zero', () => {
    expect(share(0, 0)).toBeNull();
  });
});
