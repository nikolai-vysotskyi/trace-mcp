import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Meta descriptions have to survive the SERP snippet, which cuts at roughly
 * 160 characters on desktop and less on mobile.
 *
 * A crawl of all 24 sitemap URLs on 2026-09-04 found 14 over that limit — the
 * /vs/ cluster worst, up to 294 characters, so every comparison page's snippet
 * ended mid-clause on the sentence that says what the comparison found. Five
 * more sat under 135 and left snippet space unused.
 *
 * The window is deliberately wide: this catches a description written without
 * the limit in mind, it does not police wording.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DOCS = join(REPO_ROOT, 'docs');

const MIN = 110;
const MAX = 160;

/**
 * docs/index.html writes its own `<meta name="description">` with Liquid
 * interpolation from `_data/pr_context_bench.json`, so its rendered length is
 * not readable from the source. Every other sitemap page carries a plain
 * `description:` in front matter.
 */
function frontMatterDescription(source: string): string | undefined {
  const raw = readFileSync(join(DOCS, source), 'utf-8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  const line = fm?.match(/^description:[ \t]*(.+)$/m)?.[1]?.trim();
  return line?.replace(/^"(.*)"$/, '$1');
}

describe('docs meta descriptions', () => {
  it('every sitemap page has a description that fits a search snippet', async () => {
    const { sourceFor } = await import('../../scripts/gen-sitemap.mjs');
    const xml = readFileSync(join(DOCS, 'sitemap.xml'), 'utf-8');
    const offenders = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => m[1].replace(/^https:\/\/trace-mcp\.com(?=\/)/, ''))
      .filter((path) => path !== '/')
      .map((path) => ({ path, description: frontMatterDescription(sourceFor(path)) }))
      .filter(
        ({ description }) => !description || description.length < MIN || description.length > MAX,
      )
      .map(({ path, description }) => `${path} (${description ? description.length : 'missing'})`);

    expect(
      offenders,
      `descriptions outside ${MIN}-${MAX} characters — over the limit is cut mid-sentence in the SERP, under it wastes the snippet: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
