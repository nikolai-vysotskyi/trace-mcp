#!/usr/bin/env node
/* check-i18n.mjs — fail on a user-facing string that went back inline (TRA-379).
 *
 * Scope is an allowlist, not the whole tree, and that is the point: string
 * extraction lands surface by surface, so this file is where a finished slice
 * records that it is finished. Adding a path here without extracting it turns
 * the build red, which is the only enforcement that survives a busy week.
 *
 * What it catches: JSX text nodes and the four attributes that carry prose
 * (title, label, placeholder, aria-label). What it does not: a string handed to
 * a function, or one built by concatenation — those need a parser and review
 * catches them. A line ending in `// i18n-exempt` is skipped, for the handful
 * of literals that are genuinely not prose (a URL, a keyboard glyph).
 *
 * Run: pnpm --filter trace-mcp-app run check:i18n
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** Extracted surfaces. Grow this as slices land; never shrink it. */
const CHECKED = [
  'src/shared/i18n',
  'src/renderer/i18n',
  'src/renderer/update-check.ts',
];

const PROSE_ATTRS = /\b(?:title|label|placeholder|aria-label)=(["'])([^"'{}]+)\1/g;
/* A JSX text node: between `>` and `<`, with no braces (an expression is not a
   literal) and at least two letters in a row somewhere. The lookbehind keeps
   `=>` out of it — `(a) => b < c` is a comparison, not a rendered string. */
const JSX_TEXT = /(?<![=<])>(\s*[^<>{}\n]*[A-Za-z]{2}[^<>{}]*)</g;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

/** Punctuation, glyphs, single tokens: not prose, not worth a catalogue key. */
function isProse(text) {
  const t = text.trim();
  if (t.length < 3) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false;
  // Identifiers and paths — `data-menu-row`, `src/renderer`, `useTheme`.
  if (!/\s/.test(t) && /[/_.:]|[a-z][A-Z]/.test(t)) return false;
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
    lines.forEach((line, i) => {
      if (line.includes('i18n-exempt') || COMMENT.test(line)) return;
      for (const re of [PROSE_ATTRS, JSX_TEXT]) {
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
