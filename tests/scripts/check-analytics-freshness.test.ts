/**
 * TRA-695: the threshold logic behind scripts/check-analytics-freshness.mjs.
 * Kept pure so the check is testable without a home directory or a database.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import { evaluateFreshness } from '../../scripts/check-analytics-freshness.mjs';

const HOUR = 3_600_000;
const now = Date.parse('2026-09-02T18:00:00.000Z');

describe('evaluateFreshness()', () => {
  it('passes when the watermark trails the newest log by less than the limit', () => {
    const r = evaluateFreshness({
      parsedAtMs: now - 2 * HOUR,
      newestLogMs: now,
      maxAgeHours: 24,
    });
    expect(r.ok).toBe(true);
    expect(r.behindHours).toBe(2);
  });

  it('fails on the seven-day gap that TRA-695 found', () => {
    const r = evaluateFreshness({
      parsedAtMs: Date.parse('2026-08-26T05:03:12.638Z'),
      newestLogMs: now,
      maxAgeHours: 24,
    });
    expect(r.ok).toBe(false);
    expect(r.behindHours).toBeGreaterThan(168);
  });

  it('fails when the DB has never ingested anything but logs exist', () => {
    const r = evaluateFreshness({ parsedAtMs: null, newestLogMs: now, maxAgeHours: 24 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('never');
  });

  it('passes on a machine with no session logs at all', () => {
    const r = evaluateFreshness({ parsedAtMs: null, newestLogMs: null, maxAgeHours: 24 });
    expect(r.ok).toBe(true);
  });

  it('reports zero rather than a negative gap when the watermark is ahead', () => {
    const r = evaluateFreshness({
      parsedAtMs: now,
      newestLogMs: now - HOUR,
      maxAgeHours: 24,
    });
    expect(r.ok).toBe(true);
    expect(r.behindHours).toBe(0);
  });
});
