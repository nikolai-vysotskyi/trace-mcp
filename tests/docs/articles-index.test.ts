import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ORDER,
  buildArticles,
  renderArticles,
  withoutStamp,
} from '../../scripts/articles-index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const ARTICLES_MD = join(DOCS, 'articles.md');
const SITEMAP = join(DOCS, 'sitemap.xml');
const LAYOUT = join(DOCS, '_layouts/default.html');

function sitemapPaths(): string[] {
  const xml = readFileSync(SITEMAP, 'utf-8');
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)]
    .map((m) => m[1].replace(/^https:\/\/trace-mcp\.com(?=\/)/, ''))
    .filter((p) => p !== '/' && p !== '/articles.html');
}

describe('docs/articles.md catalogue (TRA-1952)', () => {
  it('is what the generator would produce (fixed-point test)', () => {
    const current = readFileSync(ARTICLES_MD, 'utf-8');
    const generated = renderArticles();
    expect(withoutStamp(current)).toBe(withoutStamp(generated));
  });

  it('covers every indexed doc page from sitemap.xml', () => {
    const content = readFileSync(ARTICLES_MD, 'utf-8');
    const cardLinks = [
      ...content.matchAll(/<h3 class="article-card-title"><a href="([^"]+)">/g),
    ].map((match) => match[1]);
    const missing = sitemapPaths().filter((path) => !cardLinks.includes(path));
    expect(cardLinks).toHaveLength(sitemapPaths().length);
    expect(missing, `sitemap URLs missing from articles catalogue: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('gives every catalogued article a non-empty title and description', () => {
    const articles = buildArticles();
    expect(articles.length).toBeGreaterThanOrEqual(40);
    for (const article of articles) {
      expect(article.title.trim().length, `Empty title for ${article.url}`).toBeGreaterThan(0);
      expect(
        article.description.trim().length,
        `Empty description for ${article.url}`,
      ).toBeGreaterThan(0);
      expect(
        CATEGORY_ORDER.includes(article.category),
        `Invalid category ${article.category} for ${article.url}`,
      ).toBe(true);
    }
  });

  it('covers all 6 expected categories', () => {
    const articles = buildArticles();
    const categoriesFound = new Set(articles.map((a) => a.category));
    for (const cat of CATEGORY_ORDER) {
      expect(categoriesFound.has(cat), `Missing category: ${cat}`).toBe(true);
    }
  });

  it('nav jump links match section anchors', () => {
    const content = readFileSync(ARTICLES_MD, 'utf-8');
    for (const cat of CATEGORY_ORDER) {
      expect(content).toContain(`href="#${cat}"`);
      expect(content).toContain(`{#${cat}}`);
    }
  });

  it('carries valid CollectionPage + ItemList Schema.org metadata', () => {
    const content = readFileSync(ARTICLES_MD, 'utf-8');
    const schemaMatch = content.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(schemaMatch, 'Missing application/ld+json script').toBeTruthy();

    const rawJson = schemaMatch![1]
      .replace(/\{\{\s*page\.title\s*\|\s*jsonify\s*\}\}/g, '"Articles & Guides Catalogue"')
      .replace(/\{\{\s*page\.description\s*\|\s*jsonify\s*\}\}/g, '"Description"')
      .replace(/\{\{\s*page\.updated\s*\|\s*jsonify\s*\}\}/g, '"2026-10-19"');

    const schema = JSON.parse(rawJson);
    expect(schema['@type']).toBe('CollectionPage');
    expect(schema.url).toBe('https://trace-mcp.com/articles.html');
    expect(schema.mainEntity['@type']).toBe('ItemList');

    const articles = buildArticles();
    expect(schema.mainEntity.numberOfItems).toBe(articles.length);
    expect(schema.mainEntity.itemListElement.length).toBe(articles.length);
  });

  it('every markdown source with category belongs to CATEGORY_ORDER', () => {
    const files = readdirSync(DOCS, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => !f.startsWith('_'));

    for (const file of files) {
      const raw = readFileSync(join(DOCS, file), 'utf-8');
      const catMatch = raw.match(/^category:\s*([^\n]+)/m);
      if (catMatch) {
        const cat = catMatch[1].trim();
        expect(
          CATEGORY_ORDER.includes(cat as any),
          `File ${file} has unknown category: ${cat}`,
        ).toBe(true);
      }
    }
  });

  it('layout default.html renders article-spoke-backlink for category pages', () => {
    const layout = readFileSync(LAYOUT, 'utf-8');
    expect(layout).toContain('article-spoke-backlink');
    expect(layout).toContain('/articles.html#');
  });

  it('hub page articles.md does not have a category front-matter field', () => {
    const content = readFileSync(ARTICLES_MD, 'utf-8');
    const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fm).toBeTruthy();
    expect(fm![1]).not.toMatch(/^category:/m);
  });
});
