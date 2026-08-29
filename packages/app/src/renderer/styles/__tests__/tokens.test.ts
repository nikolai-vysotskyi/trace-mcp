import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs helper, shared with the CLI check (TRA-289)
import { contrast, contrastFailures, contrastTable, tokenGuard } from '../../../../scripts/design-tokens.mjs';

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

  it('adds no raw hex or Tailwind grey beyond the recorded baseline', () => {
    const { violations } = tokenGuard();
    expect(violations).toEqual([]);
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
