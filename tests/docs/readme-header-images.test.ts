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
});
