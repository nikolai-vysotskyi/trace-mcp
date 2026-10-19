#!/usr/bin/env tsx
/**
 * Generates docs/articles.md — the comprehensive catalogue of trace-mcp articles,
 * guides, benchmarks, framework references, and comparisons (TRA-1952).
 *
 * Generated from docs/sitemap.xml and the front matter of each documented page.
 * Validates that every indexed page carries a category and appears in the catalogue.
 *
 * Usage: pnpm run docs:articles [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFor } from './gen-sitemap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const OUT = path.join(DOCS, 'articles.md');
const SITEMAP = path.join(DOCS, 'sitemap.xml');

export const CATEGORY_ORDER = [
  'vs-comparisons',
  'benchmarks',
  'guides',
  'frameworks',
  'reference',
  'concepts',
] as const;

export type CategoryKey = (typeof CATEGORY_ORDER)[number];

export const CATEGORY_TITLES: Record<CategoryKey, string> = {
  'vs-comparisons': 'VS Comparisons',
  benchmarks: 'Benchmarks',
  guides: 'Guides',
  frameworks: 'Frameworks',
  reference: 'Reference',
  concepts: 'Concepts',
};

export interface ArticleItem {
  url: string;
  sourceFile: string;
  title: string;
  description: string;
  category: CategoryKey;
  updated: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char];
  });
}

function parseFrontMatter(content: string): Record<string, string> {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const res: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      let val = kv[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      res[key] = val;
    }
  }
  return res;
}

export function buildArticles(): ArticleItem[] {
  const xml = fs.readFileSync(SITEMAP, 'utf-8');
  const locs = [...xml.matchAll(/<loc>https:\/\/trace-mcp\.com([^<]*)<\/loc>/g)]
    .map((m) => m[1])
    .filter((p) => p !== '/' && p !== '/articles.html');

  const items: ArticleItem[] = [];

  for (const url of locs) {
    const sourceFile = sourceFor(url);
    const fullPath = path.join(DOCS, sourceFile);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Source file missing for ${url}: ${fullPath}`);
    }
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const fm = parseFrontMatter(raw);
    const category = fm.category as CategoryKey | undefined;

    if (!category || !CATEGORY_ORDER.includes(category)) {
      throw new Error(
        `Page ${sourceFile} (${url}) has invalid or missing category: "${fm.category}". Expected one of: ${CATEGORY_ORDER.join(', ')}`,
      );
    }

    const title = fm.title || url;
    const description = fm.description || '';
    const updated = fm.updated || new Date().toISOString().slice(0, 10);

    items.push({
      url,
      sourceFile,
      title,
      description,
      category,
      updated,
    });
  }

  return items;
}

function currentUpdated(): string {
  if (fs.existsSync(OUT)) {
    const match = fs.readFileSync(OUT, 'utf-8').match(/^updated:[ \t]*(\S+)/m);
    if (match) return match[1];
  }
  return new Date().toISOString().slice(0, 10);
}

export function renderArticles(): string {
  const articles = buildArticles();

  const byCategory = new Map<CategoryKey, ArticleItem[]>();
  for (const cat of CATEGORY_ORDER) {
    byCategory.set(cat, []);
  }

  for (const item of articles) {
    byCategory.get(item.category)!.push(item);
  }

  // Schema ItemList elements
  const schemaItems = articles.map((item, index) => {
    return JSON.stringify(
      {
        '@type': 'ListItem',
        position: index + 1,
        name: item.title,
        url: `https://trace-mcp.com${item.url}`,
        description: item.description,
      },
      null,
      2,
    )
      .split('\n')
      .map((line, lidx) => (lidx === 0 ? line : `      ${line}`))
      .join('\n');
  });

  const jumpNavLinks = CATEGORY_ORDER.map((cat) => {
    const count = byCategory.get(cat)!.length;
    return `<a href="#${cat}">${CATEGORY_TITLES[cat]} (${count})</a>`;
  }).join('\n  ');

  const sectionsMarkdown = CATEGORY_ORDER.map((cat) => {
    const title = CATEGORY_TITLES[cat];
    const catItems = byCategory.get(cat)!;

    const cardsHtml = catItems
      .map((item) => {
        return `<div class="article-card">
<div class="article-card-meta">
<span class="article-card-category">${escapeHtml(item.category.toUpperCase())}</span>
<time class="article-card-date">${escapeHtml(item.updated)}</time>
</div>
<h3 class="article-card-title"><a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a></h3>
<p class="article-card-desc">${escapeHtml(item.description)}</p>
</div>`;
      })
      .join('\n\n');

    return `## ${title} {#${cat}}

<div class="articles-grid">
${cardsHtml}
</div>`;
  }).join('\n\n');

  return `---
layout: default
title: "Articles & Guides Catalogue — trace-mcp"
description: "Browse all trace-mcp articles, framework guides, architecture concepts, benchmarks, tools reference, and code-intelligence MCP comparisons."
updated: ${currentUpdated()}
---

<!-- GENERATED by scripts/articles-index.ts — do not edit by hand. -->

# Articles & Guides

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  "headline": {{ page.title | jsonify }},
  "description": {{ page.description | jsonify }},
  "url": "https://trace-mcp.com/articles.html",
  "datePublished": "2026-09-25",
  "dateModified": {{ page.updated | jsonify }},
  "author": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "publisher": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://trace-mcp.com/articles.html"
  },
  "mainEntity": {
    "@type": "ItemList",
    "name": "trace-mcp documentation and articles catalogue",
    "numberOfItems": ${articles.length},
    "itemListElement": [
      ${schemaItems.join(',\n      ')}
    ]
  }
}
</script>

The complete index of trace-mcp documentation, architectural deep dives, benchmarks,
and head-to-head comparisons against other tools in the code-intelligence ecosystem.

<nav class="articles-nav" aria-label="Article categories">
  <span class="articles-nav-label">Sections:</span>
  ${jumpNavLinks}
</nav>

${sectionsMarkdown}
`;
}

export const withoutStamp = (page: string): string => page.replace(/^updated:.*\n/m, '');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const page = renderArticles();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (withoutStamp(current) !== withoutStamp(page)) {
      process.stderr.write('docs/articles.md is stale. Run: pnpm run docs:articles\n');
      process.exit(1);
    }
    process.stdout.write('docs/articles.md is up to date\n');
  } else {
    fs.writeFileSync(OUT, page);
    process.stdout.write(`Wrote docs/articles.md (${buildArticles().length} articles)\n`);
  }
}
