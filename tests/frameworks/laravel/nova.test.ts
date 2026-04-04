/**
 * Tests for Laravel Nova v2–v5 extraction.
 * Covers: Resource→Model, relationship fields, actions/filters/lenses,
 * metrics, and v4+ fieldsForIndex()/panels.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractNovaResource,
  extractNovaMetric,
} from '../../../src/indexer/plugins/integration/framework/laravel/nova.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/nova-v5');

function read(rel: string) {
  return fs.readFileSync(path.join(FIXTURE, rel), 'utf-8');
}

// ─── User Resource (v5, flat fields()) ───────────────────────

describe('Nova v5 — User Resource', () => {
  const source = read('app/Nova/User.php');
  const info = extractNovaResource(source, 'app/Nova/User.php');

  it('detects the resource', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('User');
    expect(info!.fqn).toBe('App\\Nova\\User');
  });

  it('extracts model FQN from inline ::class', () => {
    expect(info!.modelFqn).toBe('App\\Models\\User');
  });

  it('extracts BelongsTo relationship field', () => {
    const rel = info!.fieldRelationships.find((r) => r.fieldType === 'BelongsTo');
    expect(rel).toBeDefined();
    expect(rel!.label).toBe('Role');
    expect(rel!.attribute).toBe('role');
    expect(rel!.targetResourceFqn).toBe('App\\Nova\\Role');
  });

  it('extracts HasMany relationship field', () => {
    const rel = info!.fieldRelationships.find((r) => r.fieldType === 'HasMany');
    expect(rel).toBeDefined();
    expect(rel!.label).toBe('Posts');
    expect(rel!.targetResourceFqn).toBe('App\\Nova\\Post');
  });

  it('extracts actions', () => {
    expect(info!.actions).toContain('App\\Nova\\Actions\\SendWelcomeEmail');
    expect(info!.actions).toContain('App\\Nova\\Actions\\DeactivateUser');
  });

  it('extracts filters', () => {
    expect(info!.filters).toContain('App\\Nova\\Filters\\ActiveUsers');
  });

  it('extracts lenses', () => {
    expect(info!.lenses).toContain('App\\Nova\\Lenses\\MostValuableUsers');
  });

  it('extracts metrics from cards()', () => {
    expect(info!.metrics).toContain('App\\Nova\\Metrics\\NewUsers');
  });
});

// ─── Metric extraction ────────────────────────────────────────

describe('Nova v5 — NewUsers Metric', () => {
  const source = read('app/Nova/Metrics/NewUsers.php');
  const info = extractNovaMetric(source, 'app/Nova/Metrics/NewUsers.php');

  it('detects the metric', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('NewUsers');
    expect(info!.fqn).toBe('App\\Nova\\Metrics\\NewUsers');
  });

  it('extracts queried model from $this->count()', () => {
    expect(info!.queriedModels).toContain('App\\Models\\User');
  });
});

// ─── v4+ fieldsForIndex() ─────────────────────────────────────

describe('Nova v4 — fieldsForIndex() parsing', () => {
  const source = `<?php
namespace App\\Nova;

use App\\Models\\Post;
use App\\Nova\\Author;
use Laravel\\Nova\\Fields\\BelongsTo;
use Laravel\\Nova\\Fields\\Text;
use Laravel\\Nova\\Resource;

class PostResource extends Resource
{
    public static $model = \\App\\Models\\Post::class;

    public function fieldsForIndex($request): array
    {
        return [
            Text::make('Title'),
            BelongsTo::make('Author', 'author', Author::class),
        ];
    }

    public function fieldsForCreate($request): array
    {
        return [
            Text::make('Title'),
        ];
    }
}
`;
  const info = extractNovaResource(source, 'app/Nova/PostResource.php');

  it('detects the resource', () => {
    expect(info).not.toBeNull();
  });

  it('finds BelongsTo in fieldsForIndex()', () => {
    const rel = info!.fieldRelationships.find((r) => r.fieldType === 'BelongsTo');
    expect(rel).toBeDefined();
    expect(rel!.targetResourceFqn).toBe('App\\Nova\\Author');
  });
});

// ─── Non-resource returns null ────────────────────────────────

describe('extractNovaResource — non-Nova files', () => {
  it('returns null for plain PHP class', () => {
    const source = `<?php\nnamespace App\\Models;\nclass User extends Model {}`;
    expect(extractNovaResource(source, 'app/Models/User.php')).toBeNull();
  });

  it('returns null for Filament resource', () => {
    const source = `<?php\nclass UserResource extends \\Filament\\Resources\\Resource {}`;
    expect(extractNovaResource(source, 'app/Filament/Resources/UserResource.php')).toBeNull();
  });
});

describe('extractNovaMetric — non-metric files', () => {
  it('returns null for plain PHP class', () => {
    const source = `<?php\nclass Foo {}`;
    expect(extractNovaMetric(source, 'app/Nova/Foo.php')).toBeNull();
  });
});
