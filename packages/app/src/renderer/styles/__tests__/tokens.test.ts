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
  parseColor,
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

  /* Every colour in tokens.css is 6-digit hex, so the 3-digit shorthand branch
     of parseColor is never exercised by the checks above — a bug in it would
     ship silently. Assert the expansion directly instead of hoping a future
     token happens to use the short form. */
  it('parses 3-digit hex as the same colour as its 6-digit expansion', () => {
    expect(parseColor('#0f0')).toEqual(parseColor('#00ff00'));
    expect(parseColor('#0f0')).toEqual([0, 255, 0, 1]);
  });

  it('defaults rgb() with no alpha channel to fully opaque', () => {
    expect(parseColor('rgb(10 20 30)')).toEqual([10, 20, 30, 1]);
  });

  it('parses comma-separated rgba(), not just the space/slash form', () => {
    expect(parseColor('rgba(10, 20, 30, 0.4)')).toEqual([10, 20, 30, 0.4]);
  });

  it('rejects a colour it cannot parse instead of returning garbage', () => {
    expect(() => parseColor('not-a-colour')).toThrow('unsupported colour');
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
     is behind the WINDOW, and the drift it produces goes BOTH ways — light over
     a light desktop, dark over a dark one, mid-grey at either end. Measured on
     the build before this: #222222 vs #4f4f4f in dark appearance from nothing
     but the desktop, 45 levels apart. --sidebar-scrim is the bound, and there
     has to be one in each appearance: a one-sided floor leaves the other half
     exactly as wrong, which is the mistake this test exists to prevent.

     Every value must therefore be --surface at some alpha — never `transparent`
     (unbounded) and never a colour of its own (a bound that stops tracking the
     surface it is supposed to stay near). The alpha is the guarantee, so it is
     asserted as a number. */
  it('bounds the sidebar material against --surface in BOTH appearances', () => {
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
    expect(values).not.toContain('transparent');

    for (const value of values) {
      // Either flat --surface, or --surface mixed toward transparent.
      const mix = /^color-mix\(in srgb, var\(--surface\) ([0-9.]+)%, transparent\)$/.exec(value);
      if (!mix) {
        expect(value).toBe('var(--surface)');
        continue;
      }
      // Below ~.7 the material wins again and the drift stops being bounded:
      // .78 compresses 45 levels of measured swing to under 10.
      expect(Number(mix[1])).toBeGreaterThanOrEqual(70);
    }

    // Light is the appearance with no headroom for glass — it must be flat.
    const light = values[0];
    expect(light).toBe('var(--surface)');
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

  /* TRA-521. A composite control rings its whole outer box on `:focus-within`,
     and the universal `*:focus-visible` rule in app.css then rings the part
     inside it a second time — sized to the part, and shaped like the parent
     because that rule also sets `border-radius: inherit`. On the Workspace
     toolbar that painted a blue pill straight through the "Search projects"
     placeholder and across the capsule's own boundary; the Ask composer had
     the same double ring on its textarea.

     Two wrappers had already been patched one at a time (quick open's field,
     the context row's segmented track) without anyone noticing it was one bug
     with three sites, which is exactly how the next wrapper acquires it. So
     assert the invariant instead of the fix: every wrapper that paints the
     ring on itself must also silence the ring on the parts inside it —
     either through the shared `:where(...)` rule in app.css, or with a local
     `:focus-visible { box-shadow: none }` of its own. */
  it('never rings a composite control twice', () => {
    const dir = fileURLToPath(new URL('..', import.meta.url));
    const sheets: Array<[string, string]> = [
      ['app.css', appCss],
      ...readdirSync(dir)
        .filter((f) => f.endsWith('.css'))
        .map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')] as [string, string]),
    ];
    const all = sheets.map(([, css]) => css).join('\n');

    // Wrappers that paint the focus ring on themselves: the ring rule must sit
    // ON the `:focus-within` element, not on a descendant of it (which is how
    // the sidebar styles its selected row and is not a focus ring at all).
    const wrappers = new Set<string>();
    for (const [, selector, body] of all.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/box-shadow:[^;]*(--focus-ring|--accent)/.test(body)) continue;
      for (const part of selector.split(',')) {
        const m = /\.([\w-]+):focus-within\s*$/.exec(part.trim());
        if (m) wrappers.add(m[1]);
      }
    }
    // If this ever empties, the regex above stopped matching and the guard
    // silently passes on everything.
    expect(wrappers.size).toBeGreaterThanOrEqual(3);

    const unguarded = [...wrappers].filter((cls) => {
      const escaped = cls.replace(/[-]/g, '\\-');
      const silenced = new RegExp(
        `\\.${escaped}\\b[^{}]*:focus-visible[^{}]*\\{[^{}]*box-shadow:\\s*none`,
      );
      return !silenced.test(all);
    });
    expect(unguarded).toEqual([]);
  });

  /* TRA-297: `user-select: none` on body used to be the last word, so no path,
     id, metric or error message anywhere in the app could be selected — let
     alone copied. Content opts back in; chrome inside it opts back out. */
  it('lets content text be selected while chrome stays unselectable', () => {
    expect(appCss).toMatch(/\.ws-content-body\s*\{[^}]*user-select:\s*text/);
    expect(appCss).toMatch(/\.ws-content-body button[^{]*\{[^}]*user-select:\s*none/);
  });
});
