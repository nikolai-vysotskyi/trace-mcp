import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The JSON-LD on every page has to be parseable JSON (TRA-419).
 *
 * The blocks used to be hand-written constants, so a typo was visible. They now
 * render front matter through Liquid (`{{ page.title | jsonify }}`), and a
 * broken block does not fail the Jekyll build — it ships as structured data
 * Google silently drops. This test resolves the tags the way Jekyll will and
 * parses the result.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DOCS = join(REPO_ROOT, 'docs');

const LD_BLOCK = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

/** Front-matter value, unquoted. Enough for the keys the JSON-LD renders. */
function frontMatter(raw: string, key: string): string {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const value = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
  return value.replace(/^"(.*)"$/, '$1');
}

/**
 * Resolve the Liquid the JSON-LD blocks actually use. `| jsonify` emits a
 * quoted JSON string, everything else is interpolated bare — the same
 * distinction the pages rely on.
 */
function render(block: string, raw: string): string {
  return block
    .replace(/\{\{\s*page\.(\w+)\s*\|\s*jsonify\s*\}\}/g, (_m, key: string) =>
      JSON.stringify(frontMatter(raw, key)),
    )
    .replace(/\{\{\s*site\.\w+\s*\|\s*jsonify\s*\}\}/g, '"site value"')
    .replace(
      /\{\{\s*page\.url\s*\|\s*absolute_url\s*\|\s*jsonify\s*\}\}/g,
      '"https://example.test/"',
    )
    .replace(/\{\{\s*page\.url\s*\|\s*absolute_url\s*\}\}/g, 'https://example.test/')
    .replace(/\{\{[^}]*\}\}/g, '42');
}

/** `{% if %} … {% else %} … {% endif %}` — both branches have to parse. */
function branches(block: string): string[] {
  if (!block.includes('{%')) return [block];
  const taken = block
    .replace(/\{%\s*if[^%]*%\}/g, '')
    .replace(/\{%\s*else\s*%\}[\s\S]*?\{%\s*endif\s*%\}/g, '')
    .replace(/\{%\s*endif\s*%\}/g, '');
  const skipped = block
    .replace(/\{%\s*if[^%]*%\}[\s\S]*?\{%\s*else\s*%\}/g, '')
    .replace(/\{%\s*endif\s*%\}/g, '');
  return [taken, skipped];
}

function pages(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(md|html)$/.test(entry.name)) found.push(full);
    }
  };
  walk(DOCS);
  return found;
}

describe('JSON-LD blocks', () => {
  const targets = [...pages(), join(DOCS, '_layouts', 'default.html')];

  it.each(targets.map((p) => [p.slice(REPO_ROOT.length + 1), p]))('%s parses', (_label, path) => {
    const raw = readFileSync(path, 'utf-8');
    for (const [, block] of raw.matchAll(LD_BLOCK)) {
      for (const variant of branches(block)) {
        expect(() => JSON.parse(render(variant, raw))).not.toThrow();
      }
    }
  });

  it('the entity anchor is declared once, with a stable @id', () => {
    // Every page used to declare its own author node with no @id and no
    // sameAs, so nothing tied the site to one publisher.
    for (const path of [join(DOCS, '_layouts', 'default.html'), join(DOCS, 'index.html')]) {
      const raw = readFileSync(path, 'utf-8');
      expect(raw, `${path} lost its Organization node`).toContain(
        '"@id": "https://trace-mcp.com/#organization"',
      );
      expect(raw, `${path} lost its WebSite node`).toContain(
        '"@id": "https://trace-mcp.com/#website"',
      );
    }
  });
});
