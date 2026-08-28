/* Design-token checks for packages/app/src/renderer (TRA-289).
   Two independent checks, both usable from CI and from vitest:

     contrastTable()  — WCAG contrast of every text token in both appearances
     tokenGuard()     — no NEW raw hex / text-gray-* / bg-slate-* in the renderer

   tokenGuard is baselined (token-guard.baseline.json): the pre-existing
   violations are recorded per file, and only an INCREASE fails. Each surface
   sub-issue of TRA-284 lowers a number; nobody may raise one.
   ponytail: a count baseline, not per-line suppressions — the counts only ever
   move down, and a line-level baseline would churn on every reflow. */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const rendererRoot = join(appRoot, 'src', 'renderer');
const tokensPath = join(rendererRoot, 'styles', 'tokens.css');
const baselinePath = join(appRoot, 'scripts', 'token-guard.baseline.json');

/* ── colour math ─────────────────────────────────────────────────────────── */

/** Parse `#rgb`, `#rrggbb`, `rgb(r g b / a)` or `rgba(r, g, b, a)` → [r,g,b,a]. */
export function parseColor(input) {
  const value = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (!fn) throw new Error(`unsupported colour: ${input}`);
  const [rgb, alpha] = fn[1].split('/');
  const parts = rgb.trim().split(/[\s,]+/).map(Number);
  const a = alpha !== undefined ? Number(alpha) : parts.length > 3 ? parts[3] : 1;
  return [parts[0], parts[1], parts[2], a];
}

const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export const luminance = ([r, g, b]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** Composite `fg` (may be translucent) over opaque `bg`, then WCAG-contrast it. */
export function contrast(fg, bg) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  const over = [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
  const [l1, l2] = [luminance(over), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* ── token extraction ────────────────────────────────────────────────────── */

/** Pull `--name: value;` declarations out of the block a selector opens. */
export function readBlock(css, selector) {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('\n}', open);
  const body = css.slice(open + 1, close);
  const out = {};
  for (const [, name, value] of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    out[name] = value.trim();
  }
  return out;
}

/* Text tokens that must clear AA, and the surfaces they land on.
   --label-tertiary is deliberately absent: it is decoration only. */
const TEXT_TOKENS = ['--label', '--label-secondary', '--accent', '--status-green', '--status-orange', '--status-red', '--status-blue'];
const SURFACES = ['--surface', '--surface-sunken'];
const AA_BODY = 4.5;

export function contrastTable(css = readFileSync(tokensPath, 'utf8')) {
  const appearances = {
    light: readBlock(css, ':root {'),
    dark: readBlock(css, ':root[data-theme="dark"],'),
  };
  const rows = [];
  for (const [appearance, tokens] of Object.entries(appearances)) {
    for (const token of [...TEXT_TOKENS, '--label-tertiary']) {
      for (const surface of SURFACES) {
        rows.push({
          appearance,
          token,
          surface,
          ratio: Number(contrast(tokens[token], tokens[surface]).toFixed(2)),
          required: token === '--label-tertiary' ? null : AA_BODY,
        });
      }
    }
    /* The other direction: the label a filled accent control carries. */
    rows.push({
      appearance,
      token: '--on-accent',
      surface: '--accent-fill',
      ratio: Number(contrast(tokens['--on-accent'], tokens['--accent-fill']).toFixed(2)),
      required: AA_BODY,
    });
  }
  return rows;
}

export function contrastFailures(rows = contrastTable()) {
  return rows.filter((r) => r.required !== null && r.ratio < r.required);
}

/* ── token guard ─────────────────────────────────────────────────────────── */

const SCAN_EXT = /\.(css|ts|tsx|js|jsx|html)$/;
/* A hex colour anywhere outside tokens.css. */
const RAW_HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g;
/* Tailwind's own greys — the palette we are replacing. */
const GREY_CLASS = /\b(?:text|bg|border|fill|stroke|ring|divide|from|to|via)-(?:gray|grey|slate|zinc|neutral|stone)-\d{2,3}\b/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SCAN_EXT.test(entry)) yield full;
  }
}

export function tokenGuardCounts() {
  const counts = {};
  for (const file of walk(rendererRoot)) {
    const rel = relative(appRoot, file).split(sep).join('/');
    if (rel.endsWith('src/renderer/styles/tokens.css')) continue;
    /* Generated icon data carries the vendors' own brand colours — not ours. */
    if (/\.generated\.[a-z]+$/.test(rel)) continue;
    /* Tests assert ON colour values; they are not UI. */
    if (rel.includes('/__tests__/')) continue;
    const src = readFileSync(file, 'utf8');
    const n = (src.match(RAW_HEX)?.length ?? 0) + (src.match(GREY_CLASS)?.length ?? 0);
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

export function tokenGuard() {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const counts = tokenGuardCounts();
  const violations = [];
  for (const [file, n] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (n > allowed) violations.push({ file, found: n, allowed });
  }
  const improved = Object.entries(baseline).filter(
    ([file, n]) => (counts[file] ?? 0) < n,
  );
  return { violations, improved, counts };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).pop())) {
  if (process.argv.includes('--update-baseline')) {
    writeFileSync(baselinePath, `${JSON.stringify(tokenGuardCounts(), null, 2)}\n`);
    console.log(`baseline written: ${baselinePath}`);
    process.exit(0);
  }

  const rows = contrastTable();
  console.log('| Appearance | Token | Surface | Ratio | Required |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.appearance} | \`${r.token}\` | \`${r.surface}\` | ${r.ratio}:1 | ${r.required ? `${r.required}:1` : 'decoration only'} |`,
    );
  }

  const bad = contrastFailures(rows);
  const { violations, improved } = tokenGuard();
  for (const v of violations) {
    console.error(`token-guard: ${v.file} has ${v.found} raw colours, baseline allows ${v.allowed}`);
  }
  for (const [file, n] of improved) {
    console.log(`token-guard: ${file} improved below its baseline of ${n} — lower it`);
  }
  for (const r of bad) {
    console.error(`contrast: ${r.appearance} ${r.token} on ${r.surface} is ${r.ratio}:1, needs ${r.required}:1`);
  }
  process.exit(bad.length + violations.length > 0 ? 1 : 0);
}
