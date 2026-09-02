import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');

/** One scalar out of `docs/_data/savings.yml` — a flat file of flat keys. */
function datum(name: string): string {
  const yaml = read('docs/_data/savings.yml');
  const raw = yaml.match(new RegExp(`^${name}:\\s*"?([^"\n]+)"?\\s*$`, 'm'))?.[1];
  if (raw === undefined) throw new Error(`docs/_data/savings.yml has no \`${name}\``);
  return raw.trim();
}

/**
 * The README is plain markdown — Jekyll never renders it, so it cannot read
 * `site.data` the way `docs/index.html` does and has to carry the numbers
 * literally. That is exactly the drift `counts.yml` exists to prevent, so the
 * same guard applies here: the literals must match the generated data file.
 *
 * Refresh both with `node scripts/refresh-savings.mjs`, then update the README
 * to whatever it printed.
 */
describe('README savings claim', () => {
  const readme = read('README.md');

  it('quotes the token figure from docs/_data/savings.yml', () => {
    const display = datum('tokens_display');
    expect(
      readme,
      `README should say "${display} tokens saved"; run node scripts/refresh-savings.mjs and update it`,
    ).toContain(`<strong>${display} tokens saved</strong>`);
  });

  it('quotes the dollar figure and names the model that prices it', () => {
    expect(readme).toContain(`that is ${datum('usd_display')} at`);
    // The model has to be named for the claim to be checkable at all — the
    // dollar number means nothing without the rate it was derived from.
    expect(readme).toContain(`<code>${datum('price_model')}</code> input price`);
    expect(readme).toContain(`($${datum('price_usd_per_mtok')}/Mtok)`);
  });

  it('keeps the homepage reading the data file rather than a literal', () => {
    const index = read('docs/index.html');
    for (const key of ['tokens_display', 'usd_display', 'price_model', 'price_usd_per_mtok']) {
      expect(index, `docs/index.html should render site.data.savings.${key}`).toContain(
        `site.data.savings.${key}`,
      );
    }
    // A literal on the page would silently outlive the next refresh.
    expect(index).not.toContain(`${datum('tokens_display')} tokens saved`);
  });
});

describe('savings.yml', () => {
  it('publishes floored figures, so a stale counter understates', () => {
    const tokens = Number(datum('tokens'));
    const display = datum('tokens_display');
    expect(display).toMatch(/^\d+(\.\d)?[KMB]\+$/);

    const unit = { K: 1e3, M: 1e6, B: 1e9 }[display.at(-2) as 'K' | 'M' | 'B'];
    const floored = Number.parseFloat(display) * unit;
    expect(floored).toBeLessThanOrEqual(tokens);
  });

  it('publishes a dollar floor consistent with the quoted rate', () => {
    const tokens = Number(datum('tokens'));
    const perMtok = Number(datum('price_usd_per_mtok'));
    expect(Number(datum('usd'))).toBeCloseTo((tokens / 1_000_000) * perMtok, 1);
    expect(Number(datum('usd_display').replace(/[$+]/g, ''))).toBeLessThanOrEqual(
      Number(datum('usd')),
    );
  });

  it('prices at a rate src/analytics/real-savings.ts actually quotes', () => {
    const source = read('src/analytics/real-savings.ts');
    const model = datum('price_model');
    const match = source.match(new RegExp(`'${model}':\\s*([0-9.]+)\\s*/\\s*1_000_000`));
    expect(match, `MODEL_PRICING has no entry for ${model}`).not.toBeNull();
    expect(Number(match?.[1])).toBe(Number(datum('price_usd_per_mtok')));
  });
});
