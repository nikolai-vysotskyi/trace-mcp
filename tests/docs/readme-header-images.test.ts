import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * README header regression guard — see docs/DESIGN-WEB.md §10.
 *
 * The banner ships in two cuts: 1200px for a desktop README column and 480px
 * for a phone, where GitHub scales the wide one to ~0.33 and its 25px tagline
 * arrives at 8px. `<source media>` is the only responsive lever GitHub's
 * sanitiser leaves in a README, and the first matching source wins — so the
 * max-width pair must stay above the theme source, and every referenced file
 * must exist (a missing srcset renders as a broken image, silently).
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');

const banner = README.match(/<picture>[\s\S]*?banner-dark\.png[\s\S]*?<\/picture>/)?.[0];
const BUTTONS = ['macos', 'windows', 'npm'] as const;
const button = (name: string) =>
  README.match(
    new RegExp(`<picture>(?:(?!</picture>)[\\s\\S])*?btn-${name}-dark\\.png[\\s\\S]*?</picture>`),
  )?.[0];

describe('README header images', () => {
  it('every referenced header image exists', () => {
    const refs = [...README.matchAll(/docs\/images\/readme\/[\w-]+\.png/g)].map((m) => m[0]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(existsSync(join(REPO_ROOT, ref)), `${ref} is referenced but missing`).toBe(true);
    }
  });

  it('the banner carries both cuts in both appearances', () => {
    expect(banner, 'README has no banner <picture>').toBeDefined();
    for (const file of [
      'banner-narrow-light.png',
      'banner-narrow-dark.png',
      'banner-light.png',
      'banner-dark.png',
    ]) {
      expect(banner).toContain(file);
    }
  });

  it('the narrow sources sit above the theme source', () => {
    const narrow = banner!.lastIndexOf('max-width: 500px');
    const themed = banner!.indexOf('srcset="docs/images/readme/banner-light.png"');
    expect(narrow).toBeGreaterThan(-1);
    expect(themed).toBeGreaterThan(-1);
    // First match wins: a theme source above the narrow ones would take the
    // phone back to the 1200px cut.
    expect(narrow).toBeLessThan(themed);
  });

  it('the narrow light source hides its theme query from GitHub themed-picture', () => {
    // GitHub wraps every README <picture> in a <themed-picture> element whose
    // getSourceTheme() substring-matches "(prefers-color-scheme: light)". For a
    // reader who pinned Light in Appearance it rewrites the media of any source
    // it classifies that way to match all viewports — and this source is first,
    // so the phone cut would land on a 750px desktop. Dropping the space after
    // the colon keeps the query valid and survives GitHub's sanitiser, while
    // falling outside that substring match.
    expect(banner).toContain('(max-width: 500px) and (prefers-color-scheme:light)');
    expect(banner).not.toContain('(max-width: 500px) and (prefers-color-scheme: light)');
    // The wide source must keep the spaced form: there themed-picture doing the
    // rewrite is exactly what a pinned-theme reader needs.
    expect(banner).toMatch(
      /media="\(prefers-color-scheme: light\)" srcset="docs\/images\/readme\/banner-light\.png"/,
    );
  });

  /**
   * The buttons are sized by srcset density, not by `width`, because one
   * `width` attribute serves every viewport: it can hold the desktop row at
   * 3 x 250 = 750 or let the phone cut fill the column, never both. A `width`
   * reintroduced here would pin every viewport to 250 again — and it would look
   * like a harmless tidy-up, so it gets a test rather than only a comment.
   */
  it('sizes the buttons by srcset density instead of a width attribute', () => {
    for (const name of BUTTONS) {
      const pic = button(name);
      expect(pic, `README has no <picture> for btn-${name}`).toBeDefined();
      expect(pic, `btn-${name} must not carry a width attribute`).not.toContain('width=');
      // 1600px art laid out at 250 CSS px — the desktop row, unchanged.
      expect(pic).toContain(`srcset="docs/images/readme/btn-${name}-light.png 6.4x"`);
      expect(pic).toContain(`srcset="docs/images/readme/btn-${name}-dark.png 6.4x"`);
      // 2000px art laid out at 500, wider than any phone column, so
      // max-width: 100% clamps it to the full width.
      expect(pic).toContain(`srcset="docs/images/readme/btn-${name}-narrow-light.png 4x"`);
      expect(pic).toContain(`srcset="docs/images/readme/btn-${name}-narrow-dark.png 4x"`);
    }
  });

  it('gives every button the same source order and spelling as the banner', () => {
    for (const name of BUTTONS) {
      const pic = button(name)!;
      // Same first-match-wins ordering, same themed-picture escape hatch.
      expect(pic).toContain('(max-width: 500px) and (prefers-color-scheme:light)');
      expect(pic).not.toContain('(max-width: 500px) and (prefers-color-scheme: light)');
      expect(pic.lastIndexOf('max-width: 500px')).toBeLessThan(
        pic.indexOf(`srcset="docs/images/readme/btn-${name}-light.png`),
      );
      // The <img> keeps a density too: it is the fallback for a renderer that
      // drops <picture>, and a bare src would lay out at the full 1600px.
      expect(pic).toMatch(
        new RegExp(`<img src="docs/images/readme/btn-${name}-dark\\.png" srcset=`),
      );
    }
  });
});
