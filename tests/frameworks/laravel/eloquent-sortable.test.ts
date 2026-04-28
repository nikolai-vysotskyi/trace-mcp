/**
 * Tests for spatie/eloquent-sortable extraction.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEloquentSortableModelSymbols,
  extractEloquentSortableModel,
} from '../../../src/indexer/plugins/integration/framework/laravel/eloquent-sortable.js';

const SORTABLE_MODEL = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Spatie\\EloquentSortable\\Sortable;
use Spatie\\EloquentSortable\\SortableTrait;

class MenuItem extends Model implements Sortable
{
    use SortableTrait;

    public $sortable = [
        'order_column_name' => 'position',
        'sort_when_creating' => true,
    ];
}`;

describe('eloquent-sortable — model extraction', () => {
  const info = extractEloquentSortableModel(SORTABLE_MODEL, 'app/Models/MenuItem.php');

  it('detects SortableTrait', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('MenuItem');
    expect(info!.fqn).toBe('App\\Models\\MenuItem');
  });

  it('extracts custom order_column_name', () => {
    expect(info!.orderColumn).toBe('position');
  });

  it('detects sort_when_creating', () => {
    expect(info!.sortWhenCreating).toBe(true);
  });

  it('builds a framework-role symbol', () => {
    const symbols = buildEloquentSortableModelSymbols(info!);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('MenuItem::sortable');
    expect(symbols[0].metadata!.frameworkRole).toBe('eloquent_sortable');
    expect(symbols[0].metadata!.orderColumn).toBe('position');
  });
});

describe('eloquent-sortable — interface-only model', () => {
  const source = `<?php
namespace App\\Models;
use Spatie\\EloquentSortable\\Sortable;

class Category extends Model implements Sortable
{
    // uses default order_column
}`;

  it('detects via Sortable interface', () => {
    const info = extractEloquentSortableModel(source, 'app/Models/Category.php');
    expect(info).not.toBeNull();
    expect(info!.orderColumn).toBeNull();
    expect(info!.sortWhenCreating).toBe(false);
  });
});

describe('eloquent-sortable — non-sortable model', () => {
  it('returns null for a plain model', () => {
    const source = `<?php\nnamespace App\\Models;\nclass Post extends Model\n{\n    use HasFactory;\n}`;
    expect(extractEloquentSortableModel(source, 'app/Models/Post.php')).toBeNull();
  });
});
