import { describe, expect, it } from 'vitest';
import {
  activation,
  clientReporting,
  daysObserved,
  monthWindowFull,
  retention,
  share,
  usage,
  usageByClient,
} from '../../scripts/ga4-funnel.mjs';

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

describe('clientReporting', () => {
  it('reads the real 2026-09-03 by_version as not yet readable', () => {
    // The snapshot that raised TRA-748: 12 of 120 rows on a version carrying the
    // TRA-643 client fix, nineteen hours after v3.12.0 shipped. A client split
    // over this population says nothing, and `readable` is what says so.
    const result = clientReporting([
      row('(not set)', 36),
      row('3.10.0', 26),
      row('3.11.0', 23),
      row('3.8.0', 19),
      row('3.14.0', 10),
      row('3.7.0', 2),
      row('3.12.0', 1),
      row('3.13.0', 1),
      row('3.5.2', 1),
      row('3.6.0', 1),
    ]);

    expect(result).toEqual({
      fix_version: '3.12.0',
      at_or_above: 12,
      below: 72,
      unknown: 36,
      // Over placed rows only — `(not set)` is not evidence of an old install.
      pct: 14,
      readable: false,
    });
  });

  it('opens the gate once past half the placed field', () => {
    expect(clientReporting([row('3.12.0', 6), row('3.8.0', 4)])).toMatchObject({
      pct: 60,
      readable: true,
    });
  });

  it('compares release numbers, not strings', () => {
    // '3.9.0' > '3.12.0' lexicographically; below the floor numerically.
    const result = clientReporting([row('3.9.0', 5), row('3.100.0', 5)]);

    expect(result.below).toBe(5);
    expect(result.at_or_above).toBe(5);
  });

  it('counts a prerelease of the fix as carrying it', () => {
    expect(clientReporting([row('3.12.0-rc.1', 3)]).at_or_above).toBe(3);
  });

  it('reports no version rows as null, not as an unreadable field', () => {
    expect(clientReporting([]).readable).toBeNull();
    expect(clientReporting(undefined).pct).toBeNull();
  });

  it('keeps unparseable versions out of both sides', () => {
    const result = clientReporting([row('dev', 4), row('', 2), row('3.14.0', 1)]);

    expect(result).toMatchObject({ unknown: 6, at_or_above: 1, below: 0, pct: 100 });
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

describe('daysObserved', () => {
  const on = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it('counts the first and last day inclusively', () => {
    // The ping reached published builds on 2026-08-23 (#336).
    expect(daysObserved('20260823', on('2026-09-05'))).toBe(14);
    expect(daysObserved('20260905', on('2026-09-05'))).toBe(1);
  });

  it('withholds rather than guesses when there is no usable first date', () => {
    // No rows at all, an unparseable value, and a first date in the future —
    // the last is a broken read, not a young property. All three withhold the
    // numbers this gates instead of publishing an invented age.
    for (const bad of ['', '(not set)', undefined, null, '20260930']) {
      expect(daysObserved(bad, on('2026-09-05'))).toBeNull();
    }
  });
});

describe('monthWindowFull / retention', () => {
  it('gates on the age of the data, not on week-vs-month', () => {
    expect(monthWindowFull(daysObserved('20260823', new Date('2026-09-05T12:00:00Z')))).toBe(false);
    expect(monthWindowFull(27)).toBe(false);
    expect(monthWindowFull(28)).toBe(true);
    expect(monthWindowFull(null)).toBe(false);
  });

  it('withholds DAU/MAU while the month window has a fortnight in it', () => {
    // 39 / 90 off the 2026-09-03 snapshot. Published as `retention_dau_mau_pct`
    // it invites a comparison against other products' DAU/MAU it cannot survive.
    expect(retention(39, 90, false)).toBeNull();
  });

  it('is not unlocked by one non-returning user on a young property', () => {
    // The counterexample that sank the first version of this gate: it read
    // `month > week` as "the window filled", so a single day-8 user who did not
    // return published a ten-day ratio as DAU/MAU.
    expect(retention(39, 91, monthWindowFull(10))).toBeNull();
  });

  it('publishes DAU/MAU once the property has a month of history', () => {
    expect(retention(39, 130, true)).toBe(30);
  });

  it('reports an empty property as null, never as 0% retention', () => {
    expect(retention(0, 0, true)).toBeNull();
  });
});
