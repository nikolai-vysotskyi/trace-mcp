/**
 * CSS / SCSS / SASS / LESS version feature mapping.
 *
 * Three axes:
 * - CSS spec level (features by the year browsers shipped them)
 * - Sass/SCSS compiler version (1.23 – 2.0)
 * - LESS compiler version (3.0 – 4.2)
 *
 * Detects features via regex patterns on source code because CSS files
 * are parsed without tree-sitter (no AST node types available).
 */

// ═══════════════════════════════════════════════════════
// CSS specification features — pattern → minimum spec year
// ═══════════════════════════════════════════════════════

const CSS_SPEC_FEATURES: [RegExp, string, string][] = [
  // [pattern, spec year, feature name]

  // --- 2017 ---
  [/var\s*\(\s*--/, '2017', 'CSS custom properties'],
  [/display\s*:\s*grid/, '2017', 'CSS Grid'],
  [/@supports\s*[({]/, '2017', '@supports'],

  // --- 2019 ---
  [/gap\s*:/, '2019', 'gap (flex/grid)'],
  [/aspect-ratio\s*:/, '2021', 'aspect-ratio'],

  // --- 2020 ---
  [/clamp\s*\(/, '2020', 'clamp()'],
  [/min\s*\(/, '2020', 'min()'],
  [/max\s*\(/, '2020', 'max()'],

  // --- 2021 ---
  [/accent-color\s*:/, '2021', 'accent-color'],
  [/content-visibility\s*:/, '2021', 'content-visibility'],

  // --- 2022 ---
  [/:has\s*\(/, '2022', ':has() pseudo-class'],
  [/@layer\b/, '2022', '@layer cascade layers'],
  [/@property\s+--/, '2022', '@property registered custom property'],
  [/container-type\s*:/, '2022', 'container queries (container-type)'],
  [/@container\b/, '2022', '@container queries'],
  [/overscroll-behavior\s*:/, '2022', 'overscroll-behavior'],
  [/inset\s*:/, '2022', 'logical inset shorthand'],

  // --- 2023 ---
  [/color-mix\s*\(/, '2023', 'color-mix()'],
  [/&\s*[.#:\[>+~]/, '2023', 'CSS nesting (& combinator)'],
  [/subgrid/, '2023', 'subgrid'],
  [/:nth-child\([^)]*\bof\b/, '2023', ':nth-child(An+B of S)'],
  [/text-wrap\s*:\s*balance/, '2023', 'text-wrap: balance'],
  [/margin-trim\s*:/, '2023', 'margin-trim'],
  [/initial-letter\s*:/, '2023', 'initial-letter'],

  // --- 2024 ---
  [/@scope\b/, '2024', '@scope'],
  [/@starting-style\b/, '2024', '@starting-style'],
  [/light-dark\s*\(/, '2024', 'light-dark()'],
  [/anchor\s*\(/, '2024', 'CSS anchor positioning'],
  [/position-area\s*:/, '2024', 'position-area (anchor)'],
  [/view-transition-name\s*:/, '2024', 'view transitions'],
  [/interpolate-size\s*:/, '2024', 'interpolate-size'],
  [/field-sizing\s*:/, '2024', 'field-sizing'],
  [/text-wrap\s*:\s*pretty/, '2024', 'text-wrap: pretty'],
  [
    /align-content\s*:\s*(?:center|start|end|space-between)/,
    '2024',
    'align-content on block containers',
  ],

  // --- 2025 ---
  [/if\s*\(/, '2025', 'if() inline conditional'],
  [/@function\b/, '2025', 'CSS @function'],
  [/calc-size\s*\(/, '2025', 'calc-size()'],
];

// ═══════════════════════════════════════════════════════
// Sass/SCSS compiler — pattern → minimum Sass version
// ═══════════════════════════════════════════════════════

const SASS_VERSION_FEATURES: [RegExp, string, string][] = [
  // [pattern, min Sass version, feature description]

  // --- Sass 1.23 (Oct 2019) — module system ---
  [/@use\s+['"]/, '1.23', '@use module imports'],
  [/@forward\s+['"]/, '1.23', '@forward module re-exports'],

  // --- Sass 1.33 (Jan 2021) — @use with configuration ---
  [/@use\s+['"][^'"]+['"]\s+with\s*\(/, '1.33', '@use ... with() configuration'],

  // --- Sass 1.45 (Dec 2021) — meta.load-css() ---
  [/meta\.load-css\s*\(/, '1.45', 'meta.load-css()'],

  // --- Sass 1.56 (Sep 2022) — @layer support ---
  [/@layer\b/, '1.56', '@layer in SCSS'],

  // --- Sass 1.57 (Nov 2022) — warn about / as division ---
  [/\$[\w-]+\s*\/\s*\$[\w-]+/, '1.57', 'slash-as-division deprecation warning context'],

  // --- Sass 1.63 (Jul 2023) — CSS nesting support ---
  [/&\s*[.#:\[>+~]/, '1.63', 'CSS nesting in SCSS'],

  // --- Sass 1.65 (Aug 2023) — color.channel() API ---
  [/color\.channel\s*\(/, '1.65', 'color.channel()'],

  // --- Sass 1.69 (Oct 2023) — new relative color syntax ---
  [/color\.adjust\s*\(/, '1.69', 'color.adjust()'],

  // --- Sass 1.71 (Jan 2024) — media query evaluation changes ---
  // Breaking: media queries now follow CSS spec nesting priority
  // @import deprecation warnings start being emitted for all @import usage
  [/@import\s+['"]/, '1.71', '@import (deprecation warning since 1.71)'],

  // --- Sass 1.77 (May 2024) — @import officially deprecated ---
  // Usage of @import after this version triggers deprecation by default

  // --- Sass 1.80 (Aug 2024) — color spaces, oklch, oklab ---
  [/color\.to-space\s*\(/, '1.80', 'color.to-space()'],
  [/oklch\s*\(/, '1.80', 'oklch() in SCSS context'],
  [/oklab\s*\(/, '1.80', 'oklab() in SCSS context'],

  // --- math module features (available since 1.23 but commonly used later) ---
  [/math\.div\s*\(/, '1.33', 'math.div() (replacement for / division)'],
  [/math\.clamp\s*\(/, '1.23', 'math.clamp()'],
  [/math\.pow\s*\(/, '1.23', 'math.pow()'],

  // --- string module ---
  [/string\.split\s*\(/, '1.57', 'string.split()'],

  // --- list module ---
  [/list\.slash\s*\(/, '1.40', 'list.slash()'],

  // --- map module ---
  [/map\.deep-merge\s*\(/, '1.33', 'map.deep-merge()'],
  [/map\.deep-remove\s*\(/, '1.33', 'map.deep-remove()'],
];

// ═══════════════════════════════════════════════════════
// LESS compiler — pattern → minimum LESS version
// ═══════════════════════════════════════════════════════

const LESS_VERSION_FEATURES: [RegExp, string, string][] = [
  // --- LESS 2.0 (2014) — inline JS deprecated, extend ---
  [/&:extend\s*\(/, '2.0', ':extend()'],

  // --- LESS 3.0 (2018) — major overhaul ---
  [/each\s*\(/, '3.0', 'each() function'],
  [/if\s*\(/, '3.0', 'if() function'],
  [/boolean\s*\(/, '3.0', 'boolean() function'],

  // --- LESS 3.5 (2019) ---
  [/@plugin\s+['"]/, '3.5', '@plugin'],

  // --- LESS 4.0 (2020) — math mode strict ---
  // Parentheses required for math: width: (100% / 3) instead of width: 100% / 3
  // CSS custom properties pass-through
  [/--[\w-]+\s*:/, '4.0', 'CSS custom properties pass-through (LESS 4+)'],

  // --- LESS 4.1 (2022) ---
  [/@container\b/, '4.1', '@container support in LESS'],
  [/@layer\b/, '4.1', '@layer support in LESS'],

  // --- LESS 4.2 (2023) ---
  [/@property\s+--/, '4.2', '@property support in LESS'],
];

// ═══════════════════════════════════════════════════════
// Detection functions
// ═══════════════════════════════════════════════════════

interface CssVersionInfo {
  /** Minimum CSS spec year required (e.g. "2022", "2024"). */
  minCssSpec?: string;
  /** CSS features detected. */
  cssFeatures?: string[];
  /** Minimum Sass/SCSS compiler version (e.g. "1.71"). */
  minSassVersion?: string;
  /** Sass features detected. */
  sassFeatures?: string[];
  /** Minimum LESS compiler version (e.g. "4.0"). */
  minLessVersion?: string;
  /** LESS features detected. */
  lessFeatures?: string[];
}

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

/** Detect CSS spec features, Sass version, and LESS version from source. */
export function detectCssVersions(source: string, language: string): CssVersionInfo {
  const result: CssVersionInfo = {};

  // --- CSS spec features (always checked) ---
  let maxCssYear = 0;
  const cssFeatures: string[] = [];
  for (const [re, year, name] of CSS_SPEC_FEATURES) {
    if (re.test(source)) {
      const y = Number(year);
      if (y > maxCssYear) maxCssYear = y;
      cssFeatures.push(name);
    }
  }
  if (maxCssYear > 0) {
    result.minCssSpec = String(maxCssYear);
    result.cssFeatures = cssFeatures;
  }

  // --- Sass/SCSS features ---
  if (language === 'scss' || language === 'sass') {
    let maxSass = '0';
    const sassFeatures: string[] = [];
    for (const [re, ver, name] of SASS_VERSION_FEATURES) {
      if (re.test(source)) {
        if (semverGt(ver, maxSass)) maxSass = ver;
        sassFeatures.push(name);
      }
    }
    if (maxSass !== '0') {
      result.minSassVersion = maxSass;
      result.sassFeatures = sassFeatures;
    }
  }

  // --- LESS features ---
  if (language === 'less') {
    let maxLess = '0';
    const lessFeatures: string[] = [];
    for (const [re, ver, name] of LESS_VERSION_FEATURES) {
      if (re.test(source)) {
        if (semverGt(ver, maxLess)) maxLess = ver;
        lessFeatures.push(name);
      }
    }
    if (maxLess !== '0') {
      result.minLessVersion = maxLess;
      result.lessFeatures = lessFeatures;
    }
  }

  return result;
}
