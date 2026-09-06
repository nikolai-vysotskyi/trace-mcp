// Guards on the generated lockups — see docs/DESIGN-WEB.md §1b.
//
// The geometry here was settled by eye over four rejected rounds (TRA-780) and
// none of it is derivable from anything else in the repo, so a well-meaning
// "tidy-up" would silently undo it. These assertions are the record.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const LOGO_DIR = join(REPO_ROOT, 'docs', 'images', 'logo');

const VARIANTS = ['row-light', 'row-dark', 'stack-light', 'stack-dark'] as const;
const read = (name: string) => readFileSync(join(LOGO_DIR, `lockup-${name}.svg`), 'utf-8');

describe.each(VARIANTS)('lockup %s', (name) => {
  it('exists', () => {
    expect(existsSync(join(LOGO_DIR, `lockup-${name}.svg`))).toBe(true);
  });

  it('carries no <text>, so it does not depend on a font being installed', () => {
    // The app icon shipped for years with its T as <text font-family="...">,
    // which resolved to whatever the rasteriser happened to find. The letters
    // here are the font's own contours, outlined once at authoring time.
    expect(read(name)).not.toMatch(/<text/);
    expect(read(name)).not.toMatch(/font-family/);
  });

  it('namespaces the mark ids so it can be inlined into a larger document', () => {
    // The mark brings a gradient and a clip path with it. Dropped unprefixed
    // into a page that already has a `#plate`, the wrong one wins and the plate
    // renders with someone else's fill.
    const svg = read(name);
    const [variant, theme] = name.split('-');
    for (const id of svg.match(/id="([\w-]+)"/g) ?? []) {
      if (id.includes('plate') || id.includes('shine') || id.includes('cut')) {
        expect(id).toMatch(new RegExp(`id="${theme}-${variant}-`));
      }
    }
  });

  it('draws the step in the accent, and only the step', () => {
    const svg = read(name);
    const accent = name.endsWith('dark') ? '#5B8CFF' : '#1E4FCB';
    expect(svg).toContain(`stroke="${accent}"`);
    expect(svg.match(new RegExp(accent, 'g'))).toHaveLength(1);
  });
});

describe('lockup geometry', () => {
  it('places the row mark at 885 with its centre 300 above the baseline', () => {
    // 232 — the centre of the ink block — reads as hanging, because the block is
    // dragged down by the descender of `p` while the eye reads the line off the
    // x-height. 442 lifts the mark clear of the line. 300 is the settled value.
    const svg = read('row-dark');
    const scale = Number(svg.match(/scale\(([\d.]+)\)/)?.[1]);
    expect(scale).toBeCloseTo(885 / 1024, 5);
    // Baseline sits at max(mark top above baseline, ink top) = 300 + 442.5.
    const translateY = Number(svg.match(/translate\(0 ([\d.-]+)\)/)?.[1]);
    expect(translateY).toBeCloseTo(0, 5);
  });

  it('places the stack mark at 3.6em', () => {
    const scale = Number(read('stack-dark').match(/scale\(([\d.]+)\)/)?.[1]);
    expect(scale).toBeCloseTo(3600 / 1024, 5);
  });

  it('keeps the wordmark monospaced — every letter one advance apart', () => {
    const xs = [...read('row-dark').matchAll(/translate\((\d+) [\d.]+\) scale\(1 -1\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(xs).toHaveLength(8); // trace + mcp
    const steps = xs.slice(1, 5).map((x, i) => x - xs[i]);
    for (const s of steps) expect(s).toBe(612);
  });
});

// The home page paints its own header instead of the layout's, so "the site
// header" is two files. A preview build is what surfaced that: the layout was
// updated and index.html still showed the bracketed wordmark.
describe.each([
  ['layout', 'docs/_layouts/default.html'],
  ['home page', 'docs/index.html'],
])('the site header (%s)', (_where, file) => {
  const layout = readFileSync(join(REPO_ROOT, file), 'utf-8');

  it('no longer paints the bracketed wordmark', () => {
    expect(layout).not.toMatch(/<span class="bracket">/);
  });

  it('inlines the inherit lockup rather than linking a themed file', () => {
    // The site switches themes from `data-theme` off localStorage. An <img> in a
    // <picture> keyed to prefers-color-scheme would follow the OS and silently
    // override the reader's own toggle — the same class of bug the README hit
    // with GitHub's themed-picture. Inlined, the ink is currentColor and the
    // step is var(--accent), so the lockup follows the toggle for free.
    expect(layout).toContain('class="nav-lockup"');
    expect(layout).toContain('currentColor');
    expect(layout).toContain('var(--accent');
    expect(layout).not.toMatch(/nav-lockup[\s\S]{0,400}prefers-color-scheme/);
  });

  it('keeps the header lockup in step with the generator', () => {
    // Hand-editing the inlined copy is the obvious shortcut and it silently
    // forks the logo. The markup has to be what gen-lockup.mjs emits.
    const generated = readFileSync(join(LOGO_DIR, 'lockup-row-inherit.svg'), 'utf-8');
    const paths = [...generated.matchAll(/<path d="([^"]{40,})"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(4);
    for (const d of paths) expect(layout).toContain(d);
  });
});
