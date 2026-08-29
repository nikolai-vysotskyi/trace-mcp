import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs helper, shared with the CLI check (TRA-289)
import {
  contrast,
  contrastFailures,
  contrastTable,
  tokenGuard,
  tokenGuardCounts,
} from '../../../../scripts/design-tokens.mjs';

const tokensCss = readFileSync(
  fileURLToPath(new URL('../tokens.css', import.meta.url)),
  'utf8',
);
const appCss = readFileSync(fileURLToPath(new URL('../../app.css', import.meta.url)), 'utf8');

describe('design tokens', () => {
  it('composites translucent labels before measuring contrast', () => {
    // black at .55 over white — the value the light --label-secondary uses.
    expect(contrast('rgb(0 0 0 / 0.55)', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrast('rgb(0 0 0 / 0.26)', '#ffffff')).toBeLessThan(2.5);
  });

  it('clears WCAG AA for every readable text token in both appearances', () => {
    expect(contrastFailures(contrastTable(tokensCss))).toEqual([]);
  });

  it('honours reduced motion, reduced transparency and increased contrast', () => {
    expect(tokensCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(tokensCss).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(tokensCss).toContain('@media (prefers-contrast: more)');
  });

  it('keeps the JetBrains palette out of the token layer', () => {
    expect(tokensCss).not.toContain('#3574f0');
    expect(tokensCss).not.toContain('Inter');
  });

  it('adds no raw hex, rgb() or Tailwind grey beyond the recorded baseline', () => {
    const { violations } = tokenGuard();
    expect(violations).toEqual([]);
  });

  /* TRA-355. DESIGN.md §8 rule 1 bans a raw `rgb()` by name, but the guard only
     ever counted hex and Tailwind greys — so the Workspace toolbar shipped an
     `inset 1px 0 0 rgb(255 255 255 / 0.25)` divider with a green build. These
     two files were the renderer's only palette-carrying rgb() outside the three
     exceptions recorded in DESIGN.md §12; if either reappears in the counts,
     something painted a channel instead of asking for a token. */
  it('counts a raw rgb() as a token violation, not just hex', () => {
    const counts = tokenGuardCounts();
    expect(counts['src/renderer/styles/sidebar.css']).toBeUndefined();
    expect(counts['src/renderer/workspace/AddProjectControl.tsx']).toBeUndefined();
  });

  /* Dimming a label to signal "secondary" needs surface headroom, and a filled
     accent row has none — the same call the decision log already made for the
     shortcut hint. White at .85 on --accent-fill measured 4.22:1 light and
     3.89:1 dark.

     Assert on .ws-sb-ico, not .ws-sb-count: the first version of this test
     anchored on .ws-sb-count, which is styled in sidebar.css and rendered by no
     component — so it would have passed unchanged if the rule stopped covering
     the one element that is actually on screen. A guard aimed at dead markup
     guards nothing. */
  it('paints the selected sidebar row glyph at full --on-accent', () => {
    const sidebarCss = readFileSync(
      fileURLToPath(new URL('../sidebar.css', import.meta.url)),
      'utf8',
    );
    expect(sidebarCss).toMatch(
      /\.ws-sidebar:focus-within[^{]*\.ws-sb-ico[^{]*\{[^}]*color:\s*var\(--on-accent\)/,
    );
  });

  /* TRA-344. --label-tertiary is decoration only (1.88:1 light / 2.53:1 dark,
     and `prefers-contrast: more` lifts --label-secondary but not it). A rule
     that paints text with it AND sizes that text is by definition styling
     something a user reads — the exception is a placeholder, which DESIGN.md
     §2 names as a legitimate tertiary use. Quick open's paths, ⌘-hints and
     group headers were the last three in the app. */
  it('never paints sized text with --label-tertiary', () => {
    const dir = fileURLToPath(new URL('..', import.meta.url));
    const sources: Array<[string, string]> = [
      ['app.css', appCss],
      ...readdirSync(dir)
        .filter((f) => f.endsWith('.css'))
        .map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')] as [string, string]),
    ];
    const offenders: string[] = [];
    for (const [name, css] of sources) {
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/color:\s*var\(--label-tertiary\)/.test(body)) continue;
        if (!/font-size:/.test(body)) continue;
        if (/::placeholder/.test(selector)) continue;
        offenders.push(`${name}: ${selector.trim().split('\n').pop()?.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /* TRA-297: `user-select: none` on body used to be the last word, so no path,
     id, metric or error message anywhere in the app could be selected — let
     alone copied. Content opts back in; chrome inside it opts back out. */
  it('lets content text be selected while chrome stays unselectable', () => {
    expect(appCss).toMatch(/\.ws-content-body\s*\{[^}]*user-select:\s*text/);
    expect(appCss).toMatch(/\.ws-content-body button[^{]*\{[^}]*user-select:\s*none/);
  });
});
