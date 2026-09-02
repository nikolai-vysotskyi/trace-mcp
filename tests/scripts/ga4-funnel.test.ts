import { describe, expect, it } from 'vitest';
import { activation, share, usage, usageByClient } from '../../scripts/ga4-funnel.mjs';

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

describe('usage', () => {
  it('splits installs that called a tool from installs that never did', () => {
    const result = usage([row('0', 12), row('3', 4), row('40', 3), row('900', 1)]);

    expect(result).toMatchObject({
      not_used: 12,
      used: 8,
      used_pct: 40,
      buckets: { '0': 12, '1-9': 4, '10-99': 3, '100+': 1 },
      unknown: 0,
    });
  });

  it('reports no data as null, not as 0% of installs using the tools', () => {
    // An unregistered custom dimension returns no rows. Publishing that as
    // "0% of installs called a tool" would be the most alarming lie in the file.
    expect(usage([]).used_pct).toBeNull();
    expect(usage(undefined).used_pct).toBeNull();
  });

  it('keeps GA4 cardinality overflow and unset values out of both sides', () => {
    // `(other)` is what GA4 collapses a high-cardinality dimension into, and
    // `calls` is a raw integer — counting that bucket as zero calls would
    // manufacture the exact conclusion this measurement exists to test.
    const result = usage([row('0', 2), row('(other)', 9), row('(not set)', 4), row('', 1)]);

    expect(result.unknown).toBe(14);
    expect(result.not_used).toBe(2);
    expect(result.used).toBe(0);
  });

  it('does not divide by active_users — only by the rows it placed', () => {
    // 5 installs placed, 3 of them used: 60%, whatever the property's monthly
    // active count is. Sharing against `active_users` was the TRA-643 bug.
    expect(usage([row('0', 2), row('7', 3)]).used_pct).toBe(60);
  });
});

describe('usageByClient', () => {
  /** One two-dimension GA4 row: client, `calls` value, active installs. */
  const clientRow = (client: string, calls: string, users: number) => ({
    dimensionValues: [{ value: client }, { value: calls }],
    metricValues: [{ value: String(users) }],
  });

  it('scores each client against its own installs, not the whole property', () => {
    const result = usageByClient([
      clientRow('claude-code', '0', 2),
      clientRow('claude-code', '25', 6),
      clientRow('cursor', '0', 3),
      clientRow('cursor', '4', 1),
    ]);

    // The hook-capable/hook-less split this measurement exists to answer.
    expect(result.used_pct).toEqual({ 'claude-code': 75, cursor: 25 });
    expect(result.installs).toEqual({ 'claude-code': 8, cursor: 4 });
  });

  it('handles no rows at all', () => {
    expect(usageByClient(undefined)).toEqual({ used_pct: {}, installs: {} });
  });

  it('keeps an install whose client name is a prototype key', () => {
    // The ping is unauthenticated and the client names itself, so this key is
    // reachable by anyone. On a plain `{}` the assignment is a silent no-op and
    // the install disappears from the one number that decides reach strategy.
    const result = usageByClient([clientRow('__proto__', '5', 7)]);

    expect(result.installs.__proto__).toBe(7);
    expect(result.used_pct.__proto__).toBe(100);
    expect({}.hasOwnProperty).toBeTypeOf('function'); // nothing polluted globally
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
