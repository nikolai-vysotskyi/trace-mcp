import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Emoji-free rendered pages (TRA-447).
 *
 * docs/DESIGN-WEB.md §4 forbids emoji as UI: they are filled multi-colour
 * icons, and on trace-mcp.com red is reserved as the single accent. The
 * comparison tables had drifted to 305 ✅/❌ marks on comparisons.html alone,
 * painting the page green and red. Capability marks are now ✓/✗ text, styled
 * by opacity through .mark-yes / .mark-no.
 *
 * Only the reader-facing surfaces are guarded. docs/llms-full.txt is machine
 * input, not a rendered page, so it is out of scope.
 *
 * ↔ and → are not on this list on purpose: they carry meaning in the tables
 * ("Swift ↔ ObjC", "route → handler") and render as monochrome text, so a
 * blanket \p{Extended_Pictographic} guard would be wrong here.
 */

const DOCS = join(import.meta.dirname, '..', '..', 'docs');

const FORBIDDEN = ['✅', '❌', '⚠️', '✔️', '✖️', '🟢', '🟡', '🔴'];

function renderedPages(): string[] {
  const md = readdirSync(DOCS).filter((f) => f.endsWith('.md') && f !== 'DESIGN-WEB.md');
  const vs = readdirSync(join(DOCS, 'vs')).map((f) => join('vs', f));
  return [...md, ...vs, 'index.html'];
}

describe('rendered pages carry no emoji', () => {
  it.each(renderedPages())('%s', (page) => {
    const source = readFileSync(join(DOCS, page), 'utf-8');
    const found = FORBIDDEN.filter((glyph) => source.includes(glyph));
    expect(
      found,
      `emoji in docs/${page} — use ✓/✗ text marks instead (docs/DESIGN-WEB.md §4)`,
    ).toEqual([]);
  });
});
