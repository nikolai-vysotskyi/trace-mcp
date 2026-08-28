import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Social-preview regression guard.
 *
 * A crawl of trace-mcp.com found 12 of 13 sitemap URLs emitting
 * `twitter:card=summary` with no og:image and no twitter:image — every doc
 * page shared on X / Slack / LinkedIn rendered as a bare link. Only the
 * hand-written docs/index.html carried an image.
 *
 * jekyll-seo-tag reads `page.image` only — a site-level `image:` key is NOT
 * a fallback (see ImageDrop#image_hash) — so the fix is a Jekyll `defaults`
 * block injecting it into every page's front matter. This test fails if that
 * block is removed or points at a file that no longer exists.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DOCS = join(REPO_ROOT, 'docs');

describe('docs site social preview', () => {
  const config = readFileSync(join(DOCS, '_config.yml'), 'utf-8');

  it('_config.yml injects a page-level image default for jekyll-seo-tag', () => {
    const match = config.match(/^\s*image:\s*(\S+)\s*$/m);
    expect(
      match,
      'docs/_config.yml has no `image:` default — doc pages will ship without og:image',
    ).not.toBeNull();
    if (!match) return;
    expect(config).toMatch(/^defaults:/m);
    expect(existsSync(join(DOCS, match[1].replace(/^\//, '')))).toBe(true);
  });

  it('docs/index.html keeps its own og:image (no front matter, so defaults skip it)', () => {
    const index = readFileSync(join(DOCS, 'index.html'), 'utf-8');
    expect(index).toMatch(/property="og:image"/);
  });
});
