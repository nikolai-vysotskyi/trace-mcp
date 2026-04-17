/**
 * Tests for spatie/laravel-medialibrary extraction.
 */
import { describe, it, expect } from 'vitest';
import {
  extractMediaLibraryModel,
  buildMediaLibraryModelEdges,
  buildMediaLibraryModelSymbols,
} from '../../../src/indexer/plugins/integration/framework/laravel/medialibrary.js';

const MEDIA_MODEL = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Spatie\\MediaLibrary\\HasMedia;
use Spatie\\MediaLibrary\\InteractsWithMedia;

class Article extends Model implements HasMedia
{
    use InteractsWithMedia;

    public function registerMediaCollections(): void
    {
        $this->addMediaCollection('thumbnails')->singleFile();
        $this->addMediaCollection('gallery');
    }
}`;

describe('medialibrary — model extraction', () => {
  const info = extractMediaLibraryModel(MEDIA_MODEL, 'app/Models/Article.php');

  it('detects InteractsWithMedia trait + HasMedia interface', () => {
    expect(info).not.toBeNull();
    expect(info!.hasMediaInterface).toBe(true);
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('Article');
    expect(info!.fqn).toBe('App\\Models\\Article');
  });

  it('extracts declared media collections', () => {
    expect(info!.collections).toEqual(['thumbnails', 'gallery']);
  });

  it('builds one edge per collection', () => {
    const edges = buildMediaLibraryModelEdges(info!);
    expect(edges).toHaveLength(2);
    expect(edges[0].edgeType).toBe('medialibrary_collection');
    expect(edges[0].metadata).toMatchObject({
      modelFqn: 'App\\Models\\Article',
      collection: 'thumbnails',
    });
  });

  it('builds a framework-role symbol when collections exist', () => {
    const symbols = buildMediaLibraryModelSymbols(info!);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('Article::mediaCollections');
    expect(symbols[0].metadata!.frameworkRole).toBe('medialibrary_model');
  });
});

describe('medialibrary — trait-only without interface', () => {
  const source = `<?php
namespace App\\Models;
use Spatie\\MediaLibrary\\InteractsWithMedia;

class Photo extends Model
{
    use InteractsWithMedia;
}`;

  it('still detects the model via trait alone', () => {
    const info = extractMediaLibraryModel(source, 'app/Models/Photo.php');
    expect(info).not.toBeNull();
    expect(info!.hasMediaInterface).toBe(false);
    expect(info!.collections).toEqual([]);
  });

  it('emits no symbols when no collections are declared', () => {
    const info = extractMediaLibraryModel(source, 'app/Models/Photo.php');
    expect(buildMediaLibraryModelSymbols(info!)).toEqual([]);
  });
});

describe('medialibrary — non-media model', () => {
  it('returns null for a plain model', () => {
    const source = `<?php\nnamespace App\\Models;\nclass Post extends Model\n{\n    use HasFactory;\n}`;
    expect(extractMediaLibraryModel(source, 'app/Models/Post.php')).toBeNull();
  });
});
