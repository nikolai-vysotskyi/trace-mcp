import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INFLATION_RATIO,
  PRICE_MODEL,
  PRICE_PER_TOKEN,
  sanitizedTokens,
  usd,
} from '../../scripts/ga4-savings.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** A flat series: `days` days, every one identical. */
const flat = (days: number, tokens: number, users = 10) =>
  Array.from({ length: days }, () => ({ tokens, users }));

describe('sanitizedTokens', () => {
  it('sums an unremarkable series untouched', () => {
    expect(sanitizedTokens(flat(30, 1000))).toMatchObject({
      tokens: 30_000,
      raw: 30_000,
      days: 30,
      capped_days: 0,
    });
  });

  it('caps a day inflated far past the median instead of dropping it', () => {
    const days = [...flat(29, 1000), { tokens: 50_000_000, users: 10 }];
    const result = sanitizedTokens(days);

    expect(result.capped_days).toBe(1);
    // The flood contributes 5x the median day, not 50,000x it.
    expect(result.tokens).toBe(29_000 + 5000);
    // The raw total stays visible so the gap can be published beside it.
    expect(result.raw).toBe(29_000 + 50_000_000);
  });

  it('scales the ceiling with the day’s user count', () => {
    // A day with 10x the users may legitimately carry 10x the tokens.
    const days = [...flat(29, 1000, 10), { tokens: 10_000, users: 100 }];
    expect(sanitizedTokens(days).capped_days).toBe(0);
  });

  it('does not trim a series too short to have a meaningful median', () => {
    const days = [...flat(2, 1000), { tokens: 9_000_000, users: 10 }];
    const result = sanitizedTokens(days);
    expect(result.capped_days).toBe(0);
    expect(result.tokens).toBe(result.raw);
  });

  it('trims at exactly MIN_DAYS_FOR_TRIM but not one day below it', () => {
    // The boundary itself, so an off-by-one in the guard cannot pass: 5 days
    // trim, 4 do not. Same flood in both, only the series length differs.
    const flood = { tokens: 9_000_000, users: 10 };

    expect(sanitizedTokens([...flat(4, 1000), flood])).toMatchObject({
      days: 5,
      capped_days: 1,
      tokens: 4000 + 5000,
    });
    expect(sanitizedTokens([...flat(3, 1000), flood])).toMatchObject({
      days: 4,
      capped_days: 0,
      tokens: 3000 + 9_000_000,
    });
  });

  it('survives an all-zero history without erasing it', () => {
    // A zero median would cap every day at zero if the guard were missing.
    const days = [...flat(10, 0), { tokens: 500, users: 1 }];
    expect(sanitizedTokens(days).tokens).toBe(500);
  });

  it('floors negative and non-numeric readings at zero', () => {
    const days = [
      { tokens: -100, users: 5 },
      { tokens: Number.NaN, users: 5 },
      { tokens: 200, users: 0 },
    ] as { tokens: number; users: number }[];
    expect(sanitizedTokens(days).tokens).toBe(200);
  });

  it('reports nothing for an empty series', () => {
    expect(sanitizedTokens([])).toMatchObject({ tokens: 0, raw: 0, days: 0 });
  });

  it('states the raw-to-sanitized gap as a number, and fires past the threshold', () => {
    // The two published snapshots ran 4.95x and 5.21x and nobody noticed,
    // because seeing it meant subtracting two fields across two files.
    const quiet = sanitizedTokens(flat(30, 1000));
    expect(quiet).toMatchObject({ raw_ratio: 1, inflation_suspected: false });

    const flooded = sanitizedTokens([...flat(29, 1000), { tokens: 50_000_000, users: 10 }]);
    expect(flooded.raw_ratio).toBeGreaterThan(INFLATION_RATIO);
    expect(flooded.inflation_suspected).toBe(true);
  });

  it('reports no ratio at all when there is no sanitized total to divide into', () => {
    // Null, not Infinity and not a 1 that reads as "healthy".
    expect(sanitizedTokens([])).toMatchObject({
      raw_ratio: null,
      inflation_suspected: false,
    });
  });
});

describe('usd', () => {
  it('prices tokens at the published rate', () => {
    expect(usd(1_000_000)).toBe(1);
    expect(usd(0)).toBe(0);
  });

  it('prices at the cheapest model we track, so the figure is a floor', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/analytics/real-savings.ts'), 'utf8');
    const rates = [...source.matchAll(/'claude-[\w.-]+':\s*([0-9.]+)\s*\/\s*1_000_000/g)].map((m) =>
      Number(m[1]),
    );
    expect(rates.length).toBeGreaterThan(1);
    expect(
      PRICE_PER_TOKEN * 1_000_000,
      'usd_saved is published as a floor; PRICE_MODEL must be the cheapest entry in MODEL_PRICING',
    ).toBe(Math.min(...rates));
  });
});

describe('published price', () => {
  it('matches MODEL_PRICING in src/analytics/real-savings.ts', () => {
    // The snapshot runs in CI without a build step, so it cannot import the
    // TypeScript. Read the literal instead, so the two cannot drift apart
    // silently and publish dollars at a price we no longer quote anywhere.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/analytics/real-savings.ts'), 'utf8');
    const match = source.match(new RegExp(`'${PRICE_MODEL}':\\s*([0-9.]+)\\s*/\\s*1_000_000`));
    expect(
      match,
      `MODEL_PRICING no longer has an entry for ${PRICE_MODEL}; update PRICE_MODEL/PRICE_PER_TOKEN in scripts/ga4-savings.mjs`,
    ).not.toBeNull();
    expect(Number(match?.[1]) / 1_000_000).toBe(PRICE_PER_TOKEN);
  });
});
