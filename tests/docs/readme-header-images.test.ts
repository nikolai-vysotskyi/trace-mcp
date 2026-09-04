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
});
