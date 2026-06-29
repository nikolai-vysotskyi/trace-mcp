import { describe, expect, it } from 'vitest';
import { heatDecayMultiplier } from '../../src/memory/heat.js';

const now = new Date('2026-06-30T00:00:00Z');
const isoDaysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

describe('heatDecayMultiplier — search-time temporal decay', () => {
  it('boosts (~1.5×) a decision created very recently', () => {
    const m = heatDecayMultiplier({ created_at: isoDaysAgo(0.5), last_hit_at: null }, { now });
    expect(m).toBeCloseTo(1.5, 5);
  });

  it('boosts (~1.5×) a decision recalled very recently even if created long ago', () => {
    const m = heatDecayMultiplier(
      { created_at: isoDaysAgo(400), last_hit_at: isoDaysAgo(1) },
      { now },
    );
    expect(m).toBeCloseTo(1.5, 5);
  });

  it('dampens (~0.3×) a stale decision (old created, no recent recall)', () => {
    const m = heatDecayMultiplier({ created_at: isoDaysAgo(400), last_hit_at: null }, { now });
    expect(m).toBeCloseTo(0.3, 5);
  });

  it('leaves mid-age decisions at 1.0× (neutral)', () => {
    const m = heatDecayMultiplier({ created_at: isoDaysAgo(20), last_hit_at: null }, { now });
    expect(m).toBe(1);
  });

  it('uses the most recent of created_at / last_hit_at for the boost window', () => {
    // Created long ago but a hit 2 days ago — inside the recency window → boost.
    const m = heatDecayMultiplier(
      { created_at: isoDaysAgo(90), last_hit_at: isoDaysAgo(2) },
      { now, recencyDays: 7 },
    );
    expect(m).toBeCloseTo(1.5, 5);
  });

  it('respects custom recency / stale windows', () => {
    const boost = heatDecayMultiplier(
      { created_at: isoDaysAgo(5), last_hit_at: null },
      { now, recencyDays: 10 },
    );
    expect(boost).toBeCloseTo(1.5, 5);
    const damp = heatDecayMultiplier(
      { created_at: isoDaysAgo(50), last_hit_at: null },
      { now, staleDays: 30 },
    );
    expect(damp).toBeCloseTo(0.3, 5);
  });

  it('treats unparseable timestamps as neutral (1.0×)', () => {
    const m = heatDecayMultiplier({ created_at: 'not-a-date', last_hit_at: null }, { now });
    expect(m).toBe(1);
  });
});
