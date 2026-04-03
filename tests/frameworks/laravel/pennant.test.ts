/**
 * Tests for Laravel Pennant feature flag extraction.
 * Covers: Feature::define(), Feature::active/when/value/for(),
 * #[FeatureGate] attribute, @feature Blade directive, route middleware.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractFeatureDefinitions,
  extractFeatureUsages,
  extractFeatureBladeUsages,
  extractFeatureMiddlewareUsages,
  buildPennantEdges,
} from '../../../src/indexer/plugins/framework/laravel/pennant.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-10');

function read(rel: string) {
  return fs.readFileSync(path.join(FIXTURE, rel), 'utf-8');
}

// ─── Feature definitions ──────────────────────────────────────

describe('extractFeatureDefinitions — PennantServiceProvider', () => {
  const source = read('app/Providers/PennantServiceProvider.php');
  const defs = extractFeatureDefinitions(source, 'app/Providers/PennantServiceProvider.php');

  it('finds all Feature::define() calls', () => {
    expect(defs.length).toBe(4);
  });

  it('extracts feature names', () => {
    const names = defs.map((d) => d.name);
    expect(names).toContain('new-dashboard');
    expect(names).toContain('beta-checkout');
    expect(names).toContain('dark-mode');
    expect(names).toContain('maintenance-mode');
  });

  it('records file path and line number', () => {
    const def = defs.find((d) => d.name === 'new-dashboard')!;
    expect(def.location).toBe('app/Providers/PennantServiceProvider.php');
    expect(def.line).toBeGreaterThan(0);
  });
});

describe('extractFeatureDefinitions — inline source', () => {
  it('returns empty array when no defines', () => {
    const source = `<?php\nclass Foo {}`;
    expect(extractFeatureDefinitions(source, 'Foo.php')).toHaveLength(0);
  });

  it('handles single-quoted and double-quoted names', () => {
    const source = `<?php
Feature::define("new-ui", function() { return true; });
Feature::define('legacy-ui', false);`;
    const defs = extractFeatureDefinitions(source, 'test.php');
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name)).toEqual(['new-ui', 'legacy-ui']);
  });
});

// ─── Feature usages ───────────────────────────────────────────

describe('extractFeatureUsages — DashboardController', () => {
  const source = read('app/Http/Controllers/DashboardController.php');
  const usages = extractFeatureUsages(source);

  it('detects Feature::active()', () => {
    const active = usages.filter((u) => u.usageType === 'active');
    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(active[0].name).toBe('new-dashboard');
  });

  it('detects Feature::when()', () => {
    const when = usages.filter((u) => u.usageType === 'when');
    expect(when.length).toBeGreaterThanOrEqual(1);
    expect(when[0].name).toBe('beta-checkout');
  });

  it('detects Feature::value()', () => {
    const value = usages.filter((u) => u.usageType === 'value');
    expect(value.length).toBeGreaterThanOrEqual(1);
    expect(value[0].name).toBe('dark-mode');
  });

  it('detects Feature::for()->active()', () => {
    const forUsage = usages.filter((u) => u.usageType === 'for');
    expect(forUsage.length).toBeGreaterThanOrEqual(1);
    expect(forUsage[0].name).toBe('new-dashboard');
  });

  it('records line numbers', () => {
    for (const u of usages) {
      expect(u.line).toBeGreaterThan(0);
    }
  });
});

describe('extractFeatureUsages — Feature::inactive()', () => {
  it('treats inactive as active type', () => {
    const source = `<?php
if (Feature::inactive('old-ui')) { return redirect('/new'); }`;
    const usages = extractFeatureUsages(source);
    expect(usages).toHaveLength(1);
    expect(usages[0].usageType).toBe('active');
    expect(usages[0].name).toBe('old-ui');
  });
});

describe('extractFeatureUsages — #[FeatureGate] attribute', () => {
  it('detects PHP 8 FeatureGate attribute', () => {
    const source = `<?php
class AdminController {
    #[FeatureGate('admin-panel')]
    public function index() {}

    #[FeatureGate("super-admin")]
    public function destroy() {}
}`;
    const usages = extractFeatureUsages(source);
    const attrs = usages.filter((u) => u.usageType === 'attribute');
    expect(attrs).toHaveLength(2);
    expect(attrs.map((u) => u.name)).toEqual(['admin-panel', 'super-admin']);
  });
});

// ─── Blade @feature directive ─────────────────────────────────

describe('extractFeatureBladeUsages — new.blade.php', () => {
  const source = read('resources/views/dashboard/new.blade.php');
  const usages = extractFeatureBladeUsages(source);

  it('finds all @feature directives', () => {
    expect(usages.length).toBe(3);
  });

  it('extracts feature names from Blade', () => {
    const names = usages.map((u) => u.name);
    expect(names).toContain('new-dashboard');
    expect(names).toContain('beta-checkout');
    expect(names).toContain('dark-mode');
  });

  it('marks usageType as blade', () => {
    for (const u of usages) {
      expect(u.usageType).toBe('blade');
    }
  });
});

describe('extractFeatureBladeUsages — inline', () => {
  it('returns empty when no @feature', () => {
    expect(extractFeatureBladeUsages('<div>hello</div>')).toHaveLength(0);
  });

  it('handles single-quoted names', () => {
    const source = `@feature('my-flag')\n<div/>\n@endfeature`;
    const usages = extractFeatureBladeUsages(source);
    expect(usages).toHaveLength(1);
    expect(usages[0].name).toBe('my-flag');
  });
});

// ─── Route middleware features: ───────────────────────────────

describe('extractFeatureMiddlewareUsages — web.php', () => {
  const source = read('routes/web.php');
  const usages = extractFeatureMiddlewareUsages(source);

  it('finds middleware feature flags', () => {
    expect(usages.length).toBeGreaterThanOrEqual(4);
  });

  it('extracts single-feature middleware', () => {
    const names = usages.map((u) => u.name);
    expect(names).toContain('new-dashboard');
    expect(names).toContain('maintenance-mode');
  });

  it('splits comma-separated features', () => {
    const names = usages.map((u) => u.name);
    expect(names).toContain('beta-checkout');
    expect(names).toContain('dark-mode');
  });

  it('marks usageType as middleware', () => {
    for (const u of usages) {
      expect(u.usageType).toBe('middleware');
    }
  });
});

// ─── Edge builder ─────────────────────────────────────────────

describe('buildPennantEdges', () => {
  const source = read('app/Providers/PennantServiceProvider.php');
  const defs = extractFeatureDefinitions(source, 'app/Providers/PennantServiceProvider.php');
  const ctrlSource = read('app/Http/Controllers/DashboardController.php');
  const usages = extractFeatureUsages(ctrlSource);
  const edges = buildPennantEdges(defs, usages, 'app/Http/Controllers/DashboardController.php');

  it('creates feature_defined_in edges for definitions', () => {
    const defEdges = edges.filter((e) => e.edgeType === 'feature_defined_in');
    expect(defEdges.length).toBe(4);
  });

  it('creates feature_checked_by edges for usages', () => {
    const useEdges = edges.filter((e) => e.edgeType === 'feature_checked_by');
    expect(useEdges.length).toBeGreaterThanOrEqual(4);
  });

  it('definition edge contains featureName and filePath', () => {
    const edge = edges.find(
      (e) => e.edgeType === 'feature_defined_in' && e.metadata?.featureName === 'new-dashboard',
    )!;
    expect(edge).toBeDefined();
    expect(edge.metadata?.filePath).toBe('app/Providers/PennantServiceProvider.php');
    expect(edge.metadata?.line).toBeGreaterThan(0);
  });

  it('usage edge contains usageType', () => {
    const edge = edges.find(
      (e) => e.edgeType === 'feature_checked_by' && e.metadata?.featureName === 'beta-checkout',
    )!;
    expect(edge).toBeDefined();
    expect(edge.metadata?.usageType).toBe('when');
  });
});
