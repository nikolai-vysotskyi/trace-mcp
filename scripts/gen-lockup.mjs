// Builds the trace-mcp lockups — the mark and the wordmark set together.
//
//   node scripts/gen-lockup.mjs
//
// Output: docs/images/logo/lockup-{row,stack}-{light,dark}.svg
//
// Everything here is vector and self-contained: the mark is inlined from
// packages/app/assets/icon/icon.svg, and the letters are the font's own
// contours, extracted once into scripts/wordmark-glyphs.mjs. Nothing reads a
// woff2 at build time and nothing depends on a font being installed — the same
// failure the app icon had, where the T was <text> in a family the rasteriser
// had to find (TRA-780).
//
// ── The numbers, and where they came from ───────────────────────────────────
// Everything is in the wordmark's own units, 1000 per em, so one `font-size`
// scales the whole lockup and there is no second constant to keep in sync.
//
// Measured off the rasteriser rather than the font tables, because the two
// disagree in the way that matters here: per-glyph, `t` reaches 700 and `p`
// drops to 200, but the rendered string "trace"/"mcp" inks 675 above the
// baseline and 210 below.
//
//   ROW    mark 885 tall, its centre 300 above the baseline, 275 before the
//          word. Chosen on a sweep: at 232 the mark is centred on the ink block
//          including the descender, which reads as hanging — the word has to
//          drop against the mark for the line to sit straight.
//   STACK  mark 3600 (3.6 em), 800 under it.
const ROW = { mark: 885, anchor: 300, gap: 275 };
const STACK = { mark: 3600, gap: 800 };

// The step that replaces the hyphen — DESIGN-WEB §1a, in the same units.
const STEP = { weight: 88, rise: 253, box: 900, lower: 383, airBefore: 88, airAfter: 112 };

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADVANCE, GLYPHS } from './wordmark-glyphs.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'images', 'logo');
const ICON_SRC = path.join(REPO_ROOT, 'packages/app/assets/icon/icon.svg');

const WORD = 'trace';
const WORD2 = 'mcp';
const WORD_W =
  WORD.length * ADVANCE + STEP.airBefore + STEP.box + STEP.airAfter + WORD2.length * ADVANCE;

const INK = { top: 675, bottom: 210 }; // of the rendered string, above/below baseline

// The accent is the only colour the wordmark carries, and it differs per theme
// so the step keeps its contrast on either ground (DESIGN-WEB §1).
//
// `inherit` is the variant for inlining into a page: the site switches themes
// with `data-theme` off localStorage, so a `prefers-color-scheme` swap would
// override the reader's own choice. Ink follows `currentColor` and the step
// follows the page's `--accent`, which means one file serves both themes and
// changes with the toggle rather than with the OS.
const THEMES = {
  light: { ink: '#000000', accent: '#1E4FCB' },
  dark: { ink: '#FFFFFF', accent: '#5B8CFF' },
  inherit: { ink: 'currentColor', accent: 'var(--accent, #5B8CFF)' },
};

/** The mark, lifted whole out of the app icon and namespaced so its gradient
 *  and clip ids cannot collide with anything the lockup is dropped into. */
function mark(id) {
  const src = fs.readFileSync(ICON_SRC, 'utf8');
  const body = src.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return body.replace(/(id="|url\(#)([\w-]+)/g, (_, lead, name) => `${lead}${id}-${name}`);
}

/** Letters as outlines. The glyph contours are y-up, the SVG is y-down, so the
 *  run is flipped once around the baseline rather than per glyph. */
function word(x, baseline, fill) {
  let cursor = x;
  const out = [];
  const put = (text) => {
    for (const ch of text) {
      out.push(
        `<path d="${GLYPHS[ch]}" transform="translate(${cursor} ${baseline}) scale(1 -1)" fill="${fill}"/>`,
      );
      cursor += ADVANCE;
    }
  };
  put(WORD);
  cursor += STEP.airBefore;
  const stepX = cursor;
  cursor += STEP.box + STEP.airAfter;
  put(WORD2);
  return { paths: out.join('\n  '), stepX };
}

/** The stair, centred on the x-height middle the way the hyphen it replaces is. */
function step(x, baseline, accent) {
  const cy = baseline - 496 / 2;
  return (
    `<path d="M ${x},${cy + STEP.rise / 2} H ${x + STEP.lower} V ${cy - STEP.rise / 2} ` +
    `H ${x + STEP.box}" stroke="${accent}" stroke-width="${STEP.weight}" fill="none" ` +
    `stroke-linecap="butt" stroke-linejoin="miter"/>`
  );
}

function svg({ w, h, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="trace-mcp">
  ${body}
</svg>
`;
}

function rowLockup(theme, t) {
  const markTop = ROW.anchor + ROW.mark / 2; // above the baseline
  const h = Math.max(markTop, INK.top) + Math.max(ROW.mark / 2 - ROW.anchor, INK.bottom);
  const baseline = Math.max(markTop, INK.top);
  const wordX = ROW.mark + ROW.gap;
  const { paths, stepX } = word(wordX, baseline, t.ink);
  const body = [
    `<g transform="translate(0 ${baseline - markTop}) scale(${ROW.mark / 1024})">`,
    mark(`${theme}-row`),
    '</g>',
    paths,
    step(stepX, baseline, t.accent),
  ].join('\n  ');
  return svg({ w: wordX + WORD_W, h, body });
}

function stackLockup(theme, t) {
  const w = Math.max(STACK.mark, WORD_W);
  const baseline = STACK.mark + STACK.gap + INK.top;
  const wordX = (w - WORD_W) / 2;
  const { paths, stepX } = word(wordX, baseline, t.ink);
  const body = [
    `<g transform="translate(${(w - STACK.mark) / 2} 0) scale(${STACK.mark / 1024})">`,
    mark(`${theme}-stack`),
    '</g>',
    paths,
    step(stepX, baseline, t.accent),
  ].join('\n  ');
  return svg({ w, h: baseline + INK.bottom, body });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [theme, t] of Object.entries(THEMES)) {
  for (const [name, build] of [
    ['row', rowLockup],
    ['stack', stackLockup],
  ]) {
    const file = path.join(OUT_DIR, `lockup-${name}-${theme}.svg`);
    fs.writeFileSync(file, build(theme, t));
    console.log(`  ✓ ${path.relative(REPO_ROOT, file)}`);
  }
}
