import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TOP_BAND_H,
  TRAFFIC_LIGHT_D,
  TRAFFIC_LIGHT_Y,
  trafficLightCentreY,
} from '../../../shared/chrome-metrics.js';
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

  /* TRA-369. On macOS the sidebar is a native NSVisualEffectView sampling what
     is behind the WINDOW, so in light appearance its tone is the user's
     wallpaper's decision unless something puts a floor under it. The floor is
     --sidebar-scrim: white at alpha a can never render below a*255, whatever
     the material does. Dark appearance deliberately has none — the material can
     only take it toward black, which is where it belongs.

     The alpha is the whole guarantee, so it is asserted as a number: drop it and
     a dark desktop drags the sidebar grey again, with a green build. */
  it('floors the sidebar material in light and leaves the dark one glass', () => {
    const sidebarCss = readFileSync(
      fileURLToPath(new URL('../sidebar.css', import.meta.url)),
      'utf8',
    );
    expect(sidebarCss).toMatch(
      /\[data-platform="mac"\][^{]*\.ws-sidebar\s*\{[^}]*background:\s*var\(--sidebar-scrim\)/,
    );

    const values = [...tokensCss.matchAll(/--sidebar-scrim:\s*([^;]+);/g)].map((m) => m[1].trim());
    // One per appearance block: :root, the dark media query, [data-theme="dark"]
    // / [data-mode="dark"], and the light stage.
    expect(values).toHaveLength(4);
    expect(values.filter((v) => v === 'transparent')).toHaveLength(2);
    for (const value of values.filter((v) => v !== 'transparent')) {
      const alpha = Number(/^rgb\(255 255 255 \/ ([0-9.]+)\)$/.exec(value)?.[1]);
      expect(alpha).toBeGreaterThanOrEqual(0.7);
      // #b2b2b2 on black — light enough to read as a light sidebar, not as dirt.
      expect(Math.round(alpha * 255)).toBeGreaterThanOrEqual(178);
    }
  });

  /* Reduce Transparency turns the NSVisualEffectView opaque, but it paints the
     SYSTEM's grey — which follows the system appearance, not the app's. Without
     this the sidebar disagrees with its own content pane whenever the two differ. */
  it('paints the sidebar opaque itself under reduced transparency', () => {
    const sidebarCss = readFileSync(
      fileURLToPath(new URL('../sidebar.css', import.meta.url)),
      'utf8',
    );
    expect(sidebarCss).toMatch(
      /@media \(prefers-reduced-transparency: reduce\)\s*\{[^}]*\.ws-sidebar\s*\{[^}]*background:\s*var\(--surface\)/,
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

  /* TRA-370. The traffic lights are positioned by the MAIN process and the band
     they sit in is sized by CSS. When those were two literals in two files they
     disagreed — a 44px strip centres at 22, `trafficLightPosition.y = 18` put
     the lights' centre at 25, and the comment above it claimed they matched.
     These four assertions are the guard: the token must equal the constant, the
     offset must be derived from it and land the lights on the band's centre,
     and no stylesheet may write a band height by hand again. */
  describe('the top band (TRA-370)', () => {
    it('generates --top-band-h from src/shared/chrome-metrics.ts', () => {
      expect(tokensCss).toMatch(
        new RegExp(`--top-band-h:\\s*${TOP_BAND_H}px`),
      );
    });

    it('centres the traffic lights on the band, not 3px below it', () => {
      expect(trafficLightCentreY()).toBe(TOP_BAND_H / 2);
      // Measured on the real window: y=18 renders the light's centre at 25,
      // y=15 at 22. Slope 1, so the offset that centres a 12px light in a 44px
      // band is 15 — one less than naive (44-12)/2, because the button's frame
      // carries a point above the circle.
      expect(TRAFFIC_LIGHT_Y).toBe((TOP_BAND_H - TRAFFIC_LIGHT_D) / 2 - 1);
    });

    it('sizes every top band from the token instead of a literal', () => {
      const sidebarCss = readFileSync(
        fileURLToPath(new URL('../sidebar.css', import.meta.url)),
        'utf8',
      );
      for (const selector of ['.ws-sidebar-titlebar', '.ws-content-head']) {
        const body = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(sidebarCss)?.[1];
        expect(body, `${selector} not found`).toBeDefined();
        expect(body).toMatch(/height:\s*var\(--top-band-h\)/);
      }
    });

    it('leaves no stylesheet writing a band height by hand', () => {
      const dir = fileURLToPath(new URL('..', import.meta.url));
      const offenders: string[] = [];
      for (const name of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
        const css = readFileSync(`${dir}/${name}`, 'utf8');
        for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          if (!/-webkit-app-region:\s*drag/.test(body)) continue;
          const height = /(?:^|[;{\s])height:\s*([^;]+)/.exec(body)?.[1]?.trim();
          if (height && !height.includes('var(--top-band-h)')) {
            offenders.push(`${name}: ${selector.trim().split('\n').pop()?.trim()} → ${height}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  /* TRA-297: `user-select: none` on body used to be the last word, so no path,
     id, metric or error message anywhere in the app could be selected — let
     alone copied. Content opts back in; chrome inside it opts back out. */
  it('lets content text be selected while chrome stays unselectable', () => {
    expect(appCss).toMatch(/\.ws-content-body\s*\{[^}]*user-select:\s*text/);
    expect(appCss).toMatch(/\.ws-content-body button[^{]*\{[^}]*user-select:\s*none/);
  });
});
