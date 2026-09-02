import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_DAYS_FOR_TRIM } from '../../scripts/ga4-savings.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA = 'docs/_data/savings.yml';

const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(REPO_ROOT, p));

/** One scalar out of `docs/_data/savings.yml` — a flat file of flat keys. */
function datum(name: string): string {
  const raw = read(DATA).match(new RegExp(`^${name}:\\s*"?([^"\n]+)"?\\s*$`, 'm'))?.[1];
  if (raw === undefined) throw new Error(`${DATA} has no \`${name}\``);
  return raw.trim();
}

/**
 * The counter is published only when there is something honest to publish.
 *
 * `scripts/refresh-savings.mjs` refuses to write the data file while the GA4
 * window is shorter than `MIN_DAYS_FOR_TRIM`, because below that the sanitizer
 * returns the raw sum of an unauthenticated counter untouched. So an absent
 * file is a valid state — "not publishable yet" — and the surfaces have to
 * degrade to saying nothing rather than to saying zero.
 */
describe('savings counter', () => {
  const readme = read('README.md');
  const index = read('docs/index.html');

  it('renders the homepage figure from site.data, never as a literal', () => {
    for (const key of ['tokens_display', 'usd_display', 'price_model', 'refreshed']) {
      expect(index, `docs/index.html should render site.data.savings.${key}`).toContain(
        `site.data.savings.${key}`,
      );
    }
    // Guarded, so the block disappears instead of rendering blanks when the
    // refresh has refused to produce a file.
    expect(index).toContain('{% if site.data.savings %}');
  });

  it('never claims the number only grows', () => {
    // The sanitizer recomputes one median across the whole window, so a later
    // day can lower it, retroactively cap earlier days, and pull the total
    // down while the raw sum rises. Any monotonic phrasing is a false claim.
    for (const surface of [readme, index]) {
      expect(surface).not.toMatch(/only grows|and counting|never lies|understates rather than/i);
    }
  });

  it('never claims the real saving is higher than the figure shown', () => {
    // We price one rate against a token count; we do not price the observed
    // model mix, and installs may run cheaper, local, or free models.
    for (const surface of [readme, index]) {
      expect(surface).not.toMatch(/real (figure|saving)[^.]*is higher|at least \$/i);
    }
  });

  describe.skipIf(!exists(DATA))('once the data file is published', () => {
    it('covers a window long enough to have been sanitized', () => {
      expect(
        Number(datum('days')),
        'refresh-savings.mjs should have refused to write this file',
      ).toBeGreaterThanOrEqual(MIN_DAYS_FOR_TRIM);
    });

    it('displays figures floored below the snapshot they came from', () => {
      const display = datum('tokens_display');
      expect(display).toMatch(/^\d+(\.\d)?[KMB]\+$/);
      const unit = { K: 1e3, M: 1e6, B: 1e9 }[display.at(-2) as 'K' | 'M' | 'B'];
      expect(Number.parseFloat(display) * unit).toBeLessThanOrEqual(Number(datum('tokens')));
      expect(Number(datum('usd_display').replace(/[$+]/g, ''))).toBeLessThanOrEqual(
        Number(datum('usd')),
      );
    });

    it('derives the dollar figure from the rate it names', () => {
      const perMtok = Number(datum('price_usd_per_mtok'));
      expect(Number(datum('usd'))).toBeCloseTo((Number(datum('tokens')) / 1e6) * perMtok, 1);

      const source = read('src/analytics/real-savings.ts');
      const model = datum('price_model');
      const match = source.match(new RegExp(`'${model}':\\s*([0-9.]+)\\s*/\\s*1_000_000`));
      expect(match, `MODEL_PRICING has no entry for ${model}`).not.toBeNull();
      expect(Number(match?.[1])).toBe(perMtok);
    });

    it('keeps the README literals in step with the data file', () => {
      // The README is plain markdown — Jekyll never renders it, so it cannot
      // read site.data and has to carry the numbers literally. Same drift
      // guard counts.yml exists for. Refresh, then update the README to match.
      expect(readme).toContain(`<strong>${datum('tokens_display')} tokens saved</strong>`);
      expect(readme).toContain(`<code>${datum('price_model')}</code> input rate`);
    });
  });

  it.skipIf(exists(DATA))('makes no savings claim while nothing is publishable', () => {
    expect(readme).not.toMatch(/tokens saved/i);
  });
});
