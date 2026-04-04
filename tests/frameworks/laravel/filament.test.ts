/**
 * Tests for Filament v3 extraction.
 * Covers: Resource→Model, RelationManagers, getPages(), form relationships,
 * PanelProvider registration, Widget model queries.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractFilamentResource,
  extractFilamentRelationManager,
  extractFilamentPanel,
  extractFilamentWidget,
} from '../../../src/indexer/plugins/integration/framework/laravel/filament.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/filament-v3');

function read(rel: string) {
  return fs.readFileSync(path.join(FIXTURE, rel), 'utf-8');
}

// ─── Resource ────────────────────────────────────────────────

describe('Filament v3 — UserResource', () => {
  const source = read('app/Filament/Resources/UserResource.php');
  const info = extractFilamentResource(source, 'app/Filament/Resources/UserResource.php');

  it('detects the resource', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('UserResource');
    expect(info!.fqn).toBe('App\\Filament\\Resources\\UserResource');
  });

  it('extracts model FQN', () => {
    expect(info!.modelFqn).toBe('App\\Models\\User');
  });

  it('extracts relation managers', () => {
    expect(info!.relationManagers).toHaveLength(2);
    expect(info!.relationManagers).toContain(
      'App\\Filament\\Resources\\UserResource\\RelationManagers\\PostsRelationManager',
    );
    expect(info!.relationManagers).toContain(
      'App\\Filament\\Resources\\UserResource\\RelationManagers\\CommentsRelationManager',
    );
  });

  it('extracts getPages()', () => {
    expect(info!.pages.length).toBeGreaterThanOrEqual(3);
    const actions = info!.pages.map((p) => p.action);
    expect(actions).toContain('index');
    expect(actions).toContain('create');
    expect(actions).toContain('edit');
  });

  it('extracts form ->relationship() calls', () => {
    const names = info!.formRelationships.map((r) => r.relationName);
    expect(names).toContain('role');
  });

  it('deduplicates repeated ->relationship() names', () => {
    // 'role' appears in both form Select and table SelectFilter
    const names = info!.formRelationships.map((r) => r.relationName);
    const roleCnt = names.filter((n) => n === 'role').length;
    expect(roleCnt).toBe(1);
  });
});

describe('Filament v3 — non-resource returns null', () => {
  it('returns null for plain PHP class', () => {
    const source = `<?php\nnamespace App\\Models;\nclass User extends Model {}`;
    expect(extractFilamentResource(source, 'app/Models/User.php')).toBeNull();
  });
});

// ─── RelationManager ─────────────────────────────────────────

describe('Filament v3 — PostsRelationManager', () => {
  const source = read(
    'app/Filament/Resources/UserResource/RelationManagers/PostsRelationManager.php',
  );
  const info = extractFilamentRelationManager(
    source,
    'app/Filament/Resources/UserResource/RelationManagers/PostsRelationManager.php',
  );

  it('detects the relation manager', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('PostsRelationManager');
    expect(info!.fqn).toBe(
      'App\\Filament\\Resources\\UserResource\\RelationManagers\\PostsRelationManager',
    );
  });

  it('extracts $relationship value', () => {
    expect(info!.relationshipName).toBe('posts');
  });
});

describe('Filament v3 — CommentsRelationManager', () => {
  const source = read(
    'app/Filament/Resources/UserResource/RelationManagers/CommentsRelationManager.php',
  );
  const info = extractFilamentRelationManager(
    source,
    'app/Filament/Resources/UserResource/RelationManagers/CommentsRelationManager.php',
  );

  it('extracts $relationship = comments', () => {
    expect(info!.relationshipName).toBe('comments');
  });
});

// ─── PanelProvider ────────────────────────────────────────────

describe('Filament v3 — AdminPanelProvider', () => {
  const source = read('app/Providers/Filament/AdminPanelProvider.php');
  const info = extractFilamentPanel(source, 'app/Providers/Filament/AdminPanelProvider.php');

  it('detects the panel provider', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('AdminPanelProvider');
    expect(info!.fqn).toBe('App\\Providers\\Filament\\AdminPanelProvider');
  });

  it('extracts panel id', () => {
    expect(info!.panelId).toBe('admin');
  });

  it('extracts registered resources', () => {
    expect(info!.resources).toContain('App\\Filament\\Resources\\UserResource');
    expect(info!.resources).toContain('App\\Filament\\Resources\\PostResource');
  });

  it('extracts registered pages', () => {
    expect(info!.pages).toContain('App\\Filament\\Pages\\Dashboard');
  });

  it('extracts registered widgets', () => {
    expect(info!.widgets).toContain('App\\Filament\\Widgets\\StatsOverview');
    expect(info!.widgets).toContain('App\\Filament\\Widgets\\LatestOrders');
  });
});

// ─── Widget ───────────────────────────────────────────────────

describe('Filament v3 — StatsOverview widget', () => {
  const source = read('app/Filament/Widgets/StatsOverview.php');
  const info = extractFilamentWidget(source, 'app/Filament/Widgets/StatsOverview.php');

  it('detects the widget', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('StatsOverview');
    expect(info!.fqn).toBe('App\\Filament\\Widgets\\StatsOverview');
  });

  it('has no static $model (StatsOverviewWidget)', () => {
    expect(info!.modelFqn).toBeNull();
  });

  it('extracts queried models from getStats()', () => {
    expect(info!.queriedModels).toContain('App\\Models\\User');
    expect(info!.queriedModels).toContain('App\\Models\\Order');
  });
});
