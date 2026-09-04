import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The README banner ships in four generated cuts — two themes x two widths —
 * selected by `<source media>`, the only responsive lever GitHub's markdown
 * sanitiser leaves us. Two ways that silently breaks:
 *
 *  - a renamed or un-regenerated PNG leaves a `srcset` pointing at nothing, and
 *    GitHub just falls through to the next source, so the page still looks fine
 *    on the reviewer's desktop while the phone gets the wide cut;
 *  - the sources get reordered. First match wins, so a theme-only source above
 *    the `max-width` pair swallows every phone.
 *
 * Neither shows up in a diff review. They show up here.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');

// Only the generated header assets; badge URLs and other images are not ours.
const HEADER_ASSET = /(?:src|srcset)="(docs\/images\/readme\/[^"]+)"/g;

describe('README header images', () => {
  it('every referenced header asset exists', () => {
    const refs = [...README.matchAll(HEADER_ASSET)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter((r) => !existsSync(join(REPO_ROOT, r)));
    expect(missing, `run \`node scripts/gen-readme-banner.mjs\``).toEqual([]);
  });

  it('offers the banner in both themes at both widths', () => {
    const refs = new Set([...README.matchAll(HEADER_ASSET)].map((m) => m[1]));
    for (const cut of ['light', 'dark', 'narrow-light', 'narrow-dark']) {
      expect(refs).toContain(`docs/images/readme/banner-${cut}.png`);
    }
    // The buttons deliberately have no narrow cut — `width="250"` already fits
    // a phone's column, so they stack at full size. If one appears, the README
    // and the generator have drifted apart.
    expect([...refs].filter((r) => r.includes('btn-') && r.includes('narrow'))).toEqual([]);
  });

  it('puts the max-width sources above the theme-only ones', () => {
    // Only the banner carries the two-axis selection; the star-history chart
    // and the buttons are theme-only.
    const banners = (README.match(/<picture>[\s\S]*?<\/picture>/g) ?? []).filter((p) =>
      p.includes('docs/images/readme/banner-'),
    );
    expect(banners).toHaveLength(1);
    for (const picture of banners) {
      const narrow = picture.indexOf('max-width: 500px)"');
      const themeOnly = picture.indexOf('"(prefers-color-scheme: light)"');
      expect(narrow, `no narrow source in ${picture.slice(0, 80)}`).toBeGreaterThan(-1);
      expect(themeOnly).toBeGreaterThan(narrow);
    }
  });
});
