#!/usr/bin/env node
/* check-i18n.mjs — fail on a user-facing string that went back inline (TRA-379).
 *
 * Scope is an allowlist, not the whole tree, and that is the point: string
 * extraction lands surface by surface, so this file is where a finished slice
 * records that it is finished. Adding a path here without extracting it turns
 * the build red, which is the only enforcement that survives a busy week.
 *
 * What it catches: JSX text nodes, the four attributes that carry prose (title,
 * label, placeholder, aria-label), and the same words as object properties —
 * `label: 'File'` is how the main process builds a menu, and without that rule
 * an allowlisted menu.ts would pass while reading every string inline. What it
 * does not: a string handed to a function, or one built by concatenation —
 * those need a parser and review catches them. A line ending in `// i18n-exempt` is skipped, for the handful
 * of literals that are genuinely not prose (a URL, a keyboard glyph).
 *
 * Run: pnpm --filter trace-mcp-app run check:i18n
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** Extracted surfaces. Grow this as slices land; never shrink it. */
const CHECKED = [
  'src/main/menu.ts',
  'src/main/tray.ts',
  'src/renderer/i18n',
  'src/renderer/components/GuardOnboarding.tsx',
  'src/renderer/components/GuardSection.tsx',
  'src/renderer/components/OllamaPanel.tsx',
  'src/renderer/components/ProjectStatsModal.tsx',
  'src/renderer/tabs/AIActivity.tsx',
  'src/renderer/tabs/Activity.tsx',
  'src/renderer/tabs/AskTab.tsx',
  'src/renderer/tabs/Clients.tsx',
  'src/renderer/tabs/GraphExplorerGPU.tsx',
  'src/renderer/tabs/Insights.tsx',
  'src/renderer/tabs/MemoryExplorer.tsx',
  'src/renderer/tabs/Notebook.tsx',
  'src/renderer/tabs/ProjectOverview.tsx',
  'src/renderer/tabs/Settings.tsx',
  'src/renderer/tabs/ToolActivity.tsx',
  'src/renderer/tabs/configSchema.ts',
  'src/renderer/tabs/graph-error.ts',
  'src/renderer/tabs/insights-runtime.ts',
  'src/renderer/tabs/notebook-runtime.ts',
  'src/renderer/update-check.ts',
  'src/shared/global-actions.ts',
  'src/shared/i18n',
];

const PROSE_ATTRS = /\b(?:title|label|placeholder|aria-label)=(["'])([^"'{}]+)\1/g;
/* The same words as an object property — a menu template, a dialog options bag,
   a tray item. `toolTip` is Electron's spelling. */
const PROSE_PROPS = /\b(?:title|label|placeholder|toolTip):\s*(["'])([^"'{}]+)\1/g;
/* A JSX text node: between `>` and `<`, with no braces (an expression is not a
   literal) and at least two letters in a row somewhere. The lookbehind keeps
   `=>` out of it and the lookahead keeps `>=` out — `a >= 2 || b <= 3` is
   arithmetic, not a rendered string. */
const JSX_TEXT = /(?<![=<])>(?!=)(\s*[^<>{}\n]*[A-Za-z]{2}[^<>{}]*)</g;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;
const BLOCK_OPEN = /\/\*/;
const BLOCK_CLOSE = /\*\//;

/** Punctuation, glyphs, single tokens: not prose, not worth a catalogue key. */
function isProse(text) {
  const t = text.trim();
  if (t.length < 3) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false;
  // Code, not prose: the JSX-text rule cannot tell `a > 0 && b <` from a
  // rendered string, and an operator in the middle settles it.
  if (/&&|\|\||===|!==|=>/.test(t)) return false;
  // Identifiers and paths — `data-menu-row`, `src/renderer`, `useTheme`.
  if (!/\s/.test(t) && /[/_.:]|[a-z][A-Z]/.test(t)) return false;
  /* Code the `>` … `<` window caught by accident: a generic type argument or a
     chain of comparisons reads as "text between two angle brackets" to a regex.
     A sentence never opens on a separator, and never carries `||`, `&&`, `=>`
     or a semicolon. (TRA-385 — the first slice wide enough to hit all three.) */
  if (/^[;,)\]}|&:<>=+*/-]/.test(t)) return false;
  if (/\|\||&&|=>|;/.test(t)) return false;
  return true;
}

function files(path) {
  const abs = join(ROOT, path);
  if (statSync(abs).isFile()) return [abs];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const p = join(abs, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...files(relative(ROOT, p)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const findings = [];
for (const path of CHECKED) {
  for (const file of files(path)) {
    // The catalogue is where the strings are supposed to be.
    if (file.includes('/catalog/')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    /* A block comment's CONTINUATION lines start with prose, not with `*`, and
       the ones explaining JSX quote tags — "renders a <button>s, and a <button>
       nested inside" reads to the regex as a text node. Track the comment
       across lines rather than pattern-matching each one. */
    let inBlock = false;
    lines.forEach((line, i) => {
      const wasInBlock = inBlock;
      if (BLOCK_OPEN.test(line) && !BLOCK_CLOSE.test(line.slice(line.search(BLOCK_OPEN)))) {
        inBlock = true;
      } else if (inBlock && BLOCK_CLOSE.test(line)) {
        inBlock = false;
      }
      if (wasInBlock) return;
      if (line.includes('i18n-exempt') || COMMENT.test(line)) return;
      for (const re of [PROSE_ATTRS, PROSE_PROPS, JSX_TEXT]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const text = m[2] ?? m[1];
          if (isProse(text)) {
            findings.push(`${relative(ROOT, file)}:${i + 1}  ${text.trim()}`);
          }
        }
      }
    });
  }
}

if (findings.length) {
  console.error('Inline user-facing strings in extracted surfaces:\n');
  for (const f of findings) console.error('  ' + f);
  console.error(
    '\nMove them into packages/app/src/shared/i18n/catalog/ and read them with t().' +
      '\nIf a literal is genuinely not prose, end the line with // i18n-exempt.',
  );
  process.exit(1);
}

console.log(`check-i18n: ${CHECKED.length} extracted paths clean`);
