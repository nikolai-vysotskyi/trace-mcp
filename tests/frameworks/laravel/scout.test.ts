/**
 * Tests for laravel/scout extraction.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSearchableModelEdges,
  buildSearchableModelSymbols,
  extractSearchableModel,
} from '../../../src/indexer/plugins/integration/framework/laravel/scout.js';

// ─── Searchable model ────────────────────────────────────────

const SEARCHABLE_MODEL = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Laravel\\Scout\\Searchable;

class Article extends Model
{
    use Searchable;

    public function searchableAs(): string
    {
        return 'articles_index';
    }

    public function toSearchableArray(): array
    {
        return [
            'title' => $this->title,
            'body' => $this->body,
            'author' => $this->author->name,
            'tags' => $this->tags->pluck('name')->toArray(),
        ];
    }

    public function shouldBeSearchable(): bool
    {
        return $this->isPublished();
    }
}`;

describe('scout — Searchable model extraction', () => {
  const info = extractSearchableModel(SEARCHABLE_MODEL, 'app/Models/Article.php');

  it('detects Searchable trait', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('Article');
    expect(info!.fqn).toBe('App\\Models\\Article');
  });

  it('extracts custom index name', () => {
    expect(info!.indexName).toBe('articles_index');
  });

  it('extracts searchable fields', () => {
    expect(info!.searchableFields).toContain('title');
    expect(info!.searchableFields).toContain('body');
    expect(info!.searchableFields).toContain('author');
    expect(info!.searchableFields).toContain('tags');
  });

  it('detects shouldBeSearchable', () => {
    expect(info!.shouldBeSearchable).toBe(true);
  });

  it('builds edges', () => {
    const edges = buildSearchableModelEdges(info!);
    expect(edges).toHaveLength(1);
    expect(edges[0].edgeType).toBe('scout_searchable');
    expect(edges[0].metadata.modelFqn).toBe('App\\Models\\Article');
    expect(edges[0].metadata.indexName).toBe('articles_index');
    expect(edges[0].metadata.fields).toContain('title');
  });

  it('builds symbols', () => {
    const symbols = buildSearchableModelSymbols(info!);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('Article::searchableIndex');
    expect(symbols[0].metadata!.frameworkRole).toBe('scout_index');
  });
});

// ─── Minimal Searchable (no custom index name) ──────────────

describe('scout — minimal Searchable model', () => {
  const source = `<?php
namespace App\\Models;
use Laravel\\Scout\\Searchable;

class Product extends Model
{
    use Searchable;
}`;

  const info = extractSearchableModel(source, 'app/Models/Product.php');

  it('detects Searchable trait', () => {
    expect(info).not.toBeNull();
  });

  it('has no custom index name', () => {
    expect(info!.indexName).toBeNull();
  });

  it('has no searchable fields', () => {
    expect(info!.searchableFields).toEqual([]);
  });
});

// ─── Non-Searchable model ────────────────────────────────────

describe('scout — non-Searchable model', () => {
  it('returns null for model without Searchable', () => {
    const source = `<?php\nnamespace App\\Models;\nclass Post extends Model\n{\n    use HasFactory;\n}`;
    expect(extractSearchableModel(source, 'app/Models/Post.php')).toBeNull();
  });
});
