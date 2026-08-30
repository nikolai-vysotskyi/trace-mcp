/**
 * @vitest-environment jsdom
 */
/* Geometry + contrast checks for the TRA-290 control primitives.
 *
 * Three things this locks down, all of which regressed silently before:
 *  1. every control height in controls.css is 20 / 24 / 28 — nothing else;
 *  2. every focusable primitive renders at >= 24x24 (the grade chips were
 *     21.5px and the workspace checkboxes 13px);
 *  3. every badge tone clears 4.5:1 in BOTH appearances (the grade badge was
 *     white on #ffcc00, 1.6:1).
 *
 * jsdom does not do layout, so (2) is asserted against the declared CSS box for
 * each primitive's class rather than a measured rect — which is the same thing
 * here, since every primitive sets an explicit height and the sizes are a
 * closed set.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Gallery } from '../Gallery';
import { Toolbar } from '../Surface';

// jsdom rewrites import.meta.url to an http: URL, so resolve off the vitest
// root (packages/app) instead.
const CSS = readFileSync(resolve(process.cwd(), 'src/renderer/styles/controls.css'), 'utf8');
// The palette lives in tokens.css (TRA-289); controls.css declares geometry only.
const TOKENS = readFileSync(resolve(process.cwd(), 'src/renderer/styles/tokens.css'), 'utf8');

/** Crude but sufficient rule splitter — controls.css has no nested at-rules
    other than @media, whose bodies split into rules the same way. */
const flatten = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');

function parse(src: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flatten(src))) !== null) {
    const selector = m[1].trim();
    if (selector === '' || selector.startsWith('@')) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

const rules = () => parse(CSS);

function decl(body: string, prop: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(body);
  return m?.[1].trim();
}

// ── colour maths (WCAG 2.1 relative luminance / contrast ratio) ────────────

type RGB = [number, number, number];

function hex(c: string): RGB {
  const h = c.trim().replace('#', '');
  const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [
    Number.parseInt(f.slice(0, 2), 16),
    Number.parseInt(f.slice(2, 4), 16),
    Number.parseInt(f.slice(4, 6), 16),
  ];
}

/** `color-mix(in oklab, HUE 18%, transparent)` painted over `bg`. Mixing with
    `transparent` yields the hue at 18% alpha; compositing that over an opaque
    backing is a plain source-over blend, so the oklab detour cancels out. */
function over(fg: RGB, bg: RGB, alpha: number): RGB {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as RGB;
}

function luminance([r, g, b]: RGB): number {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pull `--name` out of the first tokens.css block whose selector list carries
    `scope`. Selector lists are real there — the dark palette is declared once
    for `:root[data-theme="dark"]` and `.ws-stage[data-mode="dark"]` together. */
function token(name: string, scope: string): string {
  const block = parse(TOKENS).find((r) =>
    r.selector.split(',').some((s) => s.trim().replace(/'/g, '"') === scope),
  );
  if (!block) throw new Error(`no block for selector ${scope}`);
  const v = decl(block.body, `--${name}`);
  if (!v) throw new Error(`no --${name} in ${scope}`);
  return v;
}

const APPEARANCES = [
  { name: 'light', scope: ':root' },
  { name: 'dark', scope: ':root[data-theme="dark"]' },
] as const;

const TONES = ['neutral', 'accent', 'green', 'orange', 'red', 'blue', 'purple'] as const;

/** The fill each tone paints: the 18% tint of its hue, except neutral, which
    uses --fill-tertiary (black at 8% / white at 11%, per tokens.css). */
function badgeFill(tone: string, scope: string): RGB {
  const surface = hex(token('surface', scope));
  if (tone === 'neutral') {
    const light = scope === ':root';
    return over(light ? [0, 0, 0] : [255, 255, 255], surface, light ? 0.08 : 0.11);
  }
  const hue = hex(token(tone === 'accent' ? 'accent' : `status-${tone}`, scope));
  return over(hue, surface, 0.18);
}

describe('controls.css geometry', () => {
  const ALLOWED_HEIGHTS = new Set(['20px', '24px', '28px', '100%', '18px']);

  it('declares no control height outside 20 / 24 / 28', () => {
    const offenders: string[] = [];
    for (const { selector, body } of rules()) {
      const h = decl(body, 'height');
      if (h === undefined) continue;
      // The badge is not focusable and is sized to sit inside a 24px row.
      if (h === '18px' && !selector.includes('lx-badge')) offenders.push(`${selector} → ${h}`);
      else if (!ALLOWED_HEIGHTS.has(h)) offenders.push(`${selector} → ${h}`);
    }
    expect(offenders).toEqual([]);
  });

  it('gives every focusable primitive a >= 24px box at its default size', () => {
    const defaults: Record<string, string> = {
      '.lx-btn': '24px',
      '.lx-seg': '24px',
      '.lx-search': '24px',
      '.lx-chip': '24px',
      '.lx-popup': '24px',
      '.lx-popup select': '24px',
      '.lx-input': '24px',
      "input[type='checkbox']": '24px',
    };
    for (const [sel, want] of Object.entries(defaults)) {
      const r = rules().find((x) => x.selector === sel);
      expect(r, `missing rule ${sel}`).toBeDefined();
      expect(decl(r!.body, 'height'), sel).toBe(want);
    }
    // The checkbox paints 16px inside that 24px box via a transparent border.
    const cb = rules().find((x) => x.selector === "input[type='checkbox']")!;
    expect(decl(cb.body, 'border')).toBe('4px solid transparent');
    expect(decl(cb.body, 'width')).toBe('24px');
  });

  it('uses only capsule / 6px / 50% radii on controls', () => {
    const ALLOWED = new Set(['999px', '6px', '50%', '9px', '100%']);
    const offenders: string[] = [];
    for (const { selector, body } of rules()) {
      const r = decl(body, 'border-radius');
      if (r === undefined) continue;
      // 9px is only legal on the checkbox: 5px inner + 4px transparent border
      // is concentric with the 16px visual.
      if (r === '9px' && !selector.includes('checkbox')) offenders.push(`${selector} → ${r}`);
      // The text field is the one non-capsule control in the scale (DESIGN.md
      // §4) — a capsule field puts its first character on a curve.
      else if (r === 'var(--radius-input)' && !selector.includes('lx-input'))
        offenders.push(`${selector} → ${r}`);
      else if (r !== 'var(--radius-input)' && !ALLOWED.has(r)) offenders.push(`${selector} → ${r}`);
    }
    expect(offenders).toEqual([]);
  });

  /* TRA-522. The segmented control is the one primitive that pays a fixed 4px
     inset out of its own height, so a 20px track leaves a 16px segment holding
     a 12px label — 2px of air, which is the squeeze Nikolai reported twice: on
     the app menu's Theme pill (TRA-376) and then on the Workspace toolbar's
     Table/Compact toggle. The first fix only stopped ONE component opting in,
     which is why it recurred. The tier is gone; this keeps it gone. */
  it('has no 20px segmented control — that tier crushes its own label', () => {
    expect(rules().filter((r) => /\.lx-seg\.sz-small\b/.test(r.selector))).toEqual([]);
    expect(decl(rules().find((x) => x.selector === '.lx-seg')!.body, 'height')).toBe('24px');
  });

  it('keeps cursor: default on buttons (that is the macOS behaviour)', () => {
    const btn = rules().find((x) => x.selector === '.lx-btn')!;
    expect(decl(btn.body, 'cursor')).toBe('default');
  });

  it('honours prefers-reduced-motion', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('badge contrast', () => {
  for (const { name, scope } of APPEARANCES) {
    for (const tone of TONES) {
      it(`${tone} clears 4.5:1 in ${name}`, () => {
        const fg = hex(token(`badge-${tone}-fg`, scope));
        const ratio = contrast(fg, badgeFill(tone, scope));
        expect(
          ratio,
          `${tone}/${name}: ${ratio.toFixed(2)}:1 — pick a darker (light) or lighter (dark) label`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('never paints a badge label white', () => {
    for (const { scope } of APPEARANCES) {
      for (const tone of TONES) {
        expect(token(`badge-${tone}-fg`, scope).toLowerCase()).not.toBe('#ffffff');
      }
    }
  });
});

/* TRA-347. At the 640x420 window minimum the content pane is 420px wide and
   clips with `overflow-x: hidden` — a fixed-height, non-wrapping toolbar there
   does not shrink, scroll or clip, it just runs off the edge. Memory's row was
   703px of content in 420px, which left its search field, its prominent "Add
   decision" and its overflow menu at zero visible pixels with no scrollable
   ancestor. DESIGN.md has required `min-height` + `flex-wrap` since TRA-292;
   the rule reached the Workspace header but never the shared primitive.

   Both halves are asserted, because either one alone regresses: without the
   wrap the row clips, and without a length flex-basis on the search field the
   row wraps ~180px earlier than it must (a wrapping flex line is laid out from
   each item's hypothetical size, and `flex-basis: auto` advertises the field's
   full content width), which put Memory on two rows at the default window. */
describe('a toolbar wraps; it never clips', () => {
  it('gives Toolbar a min-height and a wrap, never a fixed height', () => {
    const { container } = render(<Toolbar>{null}</Toolbar>);
    const bar = container.querySelector('[role="toolbar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.style.minHeight).toBe('52px');
    expect(bar.style.height, 'a fixed height cannot wrap — use min-height').toBe('');
    expect(bar.className).toMatch(/\bflex-wrap\b/);
  });

  it('bases the search field on its own min-width so it shrinks before the row wraps', () => {
    const search = rules().find((x) => x.selector === '.lx-search')!;
    const min = decl(search.body, 'min-width');
    const basis = decl(search.body, 'flex')?.split(/\s+/)[2];
    expect(min).toBe('140px');
    expect(basis, 'flex-basis: auto wraps the toolbar early — use the min-width').toBe(min);
    // Capped at the content width, so where there is room it renders unchanged.
    expect(decl(search.body, 'max-width')).toBe('max-content');
    // ...and the grow variant still fills, so the cap must not leak into it.
    expect(decl(rules().find((x) => x.selector === '.lx-search.grow')!.body, 'max-width')).toBe(
      'none',
    );
  });
});

describe('gallery', () => {
  it('renders every primitive and every icon-only button has a name', () => {
    render(<Gallery />);
    // Icon-only buttons carry no text — each must be reachable by name.
    for (const btn of screen.getAllByRole('button')) {
      const name = btn.getAttribute('aria-label') ?? btn.textContent?.trim() ?? '';
      expect(name, `unnamed button: ${btn.outerHTML.slice(0, 120)}`).not.toBe('');
    }
    // Every checkbox is labelled too.
    for (const cb of screen.getAllByRole('checkbox')) {
      expect(cb.getAttribute('aria-label')).toBeTruthy();
    }
    // Grade chips are not a bare `A B C D F` row any more.
    expect(screen.getByRole('group', { name: 'Grade' })).toBeTruthy();
    // Both the grade chip and the grade badge spell the letter out.
    expect(screen.getAllByLabelText('Tech debt grade C')).toHaveLength(2);
  });
});
