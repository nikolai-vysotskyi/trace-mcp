import { describe, expect, it } from 'vitest';
import { HEAT_CEILING, computeHeat } from './heat.js';

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('computeHeat', () => {
  const now = new Date('2026-05-18T12:00:00Z');

  it('returns 0 for a brand-new row with no hits and very old created_at', () => {
    const heat = computeHeat(
      { hit_count: 0, last_hit_at: null, created_at: isoDaysAgo(now, 365) },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    // Floor exp(-365/7) ≈ 6.6e-23 — effectively zero.
    expect(heat).toBeLessThan(1e-10);
    expect(heat).toBeGreaterThanOrEqual(0);
  });

  it('gives a freshness floor close to 1 for a just-created uncalled decision', () => {
    const heat = computeHeat(
      { hit_count: 0, last_hit_at: null, created_at: now.toISOString() },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    // Age 0 → exp(0) = 1.
    expect(heat).toBeCloseTo(1, 5);
  });

  it('handles null last_hit_at by dropping the hit term', () => {
    const a = computeHeat(
      { hit_count: 50, last_hit_at: null, created_at: isoDaysAgo(now, 1) },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    const b = computeHeat(
      { hit_count: 0, last_hit_at: null, created_at: isoDaysAgo(now, 1) },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    expect(a).toBe(b); // Hit count without last_hit_at should not boost.
  });

  it('decays the hit term exponentially with age since last_hit_at', () => {
    // The formula is exp(-age/halfLifeDays) — the value drops by 1/e
    // (≈0.368) at age=halfLifeDays. This is a "characteristic time" decay,
    // not a true half-life — but matches the documented heat formula.
    const fresh = computeHeat(
      {
        hit_count: 10,
        last_hit_at: isoDaysAgo(now, 0),
        created_at: isoDaysAgo(now, 60),
      },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    const oneTau = computeHeat(
      {
        hit_count: 10,
        last_hit_at: isoDaysAgo(now, 14),
        created_at: isoDaysAgo(now, 60),
      },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    // At one characteristic time, hit term is fresh-hit-term / e ≈ 36.8%.
    const ratio = oneTau / fresh;
    expect(ratio).toBeGreaterThan(0.36);
    expect(ratio).toBeLessThan(0.38);
  });

  it('boosts the hit term proportional to hit_count', () => {
    const ten = computeHeat(
      {
        hit_count: 10,
        last_hit_at: isoDaysAgo(now, 0),
        created_at: isoDaysAgo(now, 60),
      },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    const twenty = computeHeat(
      {
        hit_count: 20,
        last_hit_at: isoDaysAgo(now, 0),
        created_at: isoDaysAgo(now, 60),
      },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    // 20 hits should be very close to 2× the heat of 10 hits — the floor
    // contribution is identical on both sides so any drift comes from the
    // hit term ratio. Floor is tiny (~1e-4) compared to a hit term of 10+.
    expect(twenty).toBeGreaterThan(1.99 * ten);
    expect(twenty).toBeLessThan(2.01 * ten);
  });

  it('respects a custom halfLifeDays', () => {
    const slow = computeHeat(
      {
        hit_count: 10,
        last_hit_at: isoDaysAgo(now, 30),
        created_at: isoDaysAgo(now, 365),
      },
      { now, halfLifeDays: 60, freshnessDays: 7 },
    );
    const fast = computeHeat(
      {
        hit_count: 10,
        last_hit_at: isoDaysAgo(now, 30),
        created_at: isoDaysAgo(now, 365),
      },
      { now, halfLifeDays: 3, freshnessDays: 7 },
    );
    expect(slow).toBeGreaterThan(fast);
  });

  it('caps at HEAT_CEILING for runaway hit_count', () => {
    const heat = computeHeat(
      {
        hit_count: 1_000_000,
        last_hit_at: now.toISOString(),
        created_at: now.toISOString(),
      },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    expect(heat).toBe(HEAT_CEILING);
  });

  it('tolerates clock skew: future created_at clamps to age 0', () => {
    const future = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const heat = computeHeat(
      { hit_count: 0, last_hit_at: null, created_at: future },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    // Should be the floor at age 0 → 1, not NaN or >1.
    expect(heat).toBeCloseTo(1, 5);
  });

  it('returns 0 when created_at is unparseable and there are no hits', () => {
    const heat = computeHeat(
      { hit_count: 0, last_hit_at: null, created_at: 'not-a-date' },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    expect(heat).toBe(0);
  });

  it('treats negative hit_count as 0 (no boost from corrupt rows)', () => {
    const heat = computeHeat(
      { hit_count: -5, last_hit_at: now.toISOString(), created_at: isoDaysAgo(now, 60) },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    // Floor ≈ exp(-60/7) ≈ 1.9e-4 for 60-day-old; hit term clamped to 0.
    // What we're asserting: the negative hit_count contributed nothing —
    // the result equals the floor exactly.
    const floorOnly = computeHeat(
      { hit_count: 0, last_hit_at: null, created_at: isoDaysAgo(now, 60) },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    expect(heat).toBe(floorOnly);
  });

  it('orders hot/recent > cold/new > hot/old in the expected way', () => {
    // Three archetypes from the spec.
    const hotRecent = computeHeat(
      {
        hit_count: 20,
        last_hit_at: isoDaysAgo(now, 0.5),
        created_at: isoDaysAgo(now, 30),
      },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    const hotOld = computeHeat(
      {
        hit_count: 20,
        last_hit_at: isoDaysAgo(now, 90),
        created_at: isoDaysAgo(now, 120),
      },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    const coldNew = computeHeat(
      {
        hit_count: 0,
        last_hit_at: null,
        created_at: isoDaysAgo(now, 1),
      },
      { now, halfLifeDays: 14, freshnessDays: 7 },
    );
    expect(hotRecent).toBeGreaterThan(coldNew);
    expect(coldNew).toBeGreaterThan(hotOld);
  });
});
