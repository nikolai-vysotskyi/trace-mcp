import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  extractInertiaRenders,
  InertiaPlugin,
  resolvePagePath,
} from '../../../src/indexer/plugins/integration/view/inertia/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/inertia-laravel-vue');

describe('InertiaPlugin', () => {
  let plugin: InertiaPlugin;

  beforeEach(() => {
    plugin = new InertiaPlugin();
  });

  describe('detect()', () => {
    it('returns true when composerJson has inertiajs/inertia-laravel', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        composerJson: { require: { 'inertiajs/inertia-laravel': '^1.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when packageJson has @inertiajs/vue3', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/test',
        packageJson: { dependencies: { '@inertiajs/vue3': '^1.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-Inertia project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-12345',
        packageJson: { dependencies: { react: '^18.0' } },
        composerJson: { require: { 'laravel/framework': '^11.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('reads from disk as fallback', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });
  });

  describe('registerSchema()', () => {
    it('returns expected edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('inertia_renders');
      expect(names).toContain('passes_props');
    });

    it('all edge types have inertia category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('inertia');
      }
    });
  });

  describe('extractInertiaRenders()', () => {
    it('extracts Inertia::render calls', () => {
      const source = `
        return Inertia::render('Users/Index', [
            'users' => $users,
            'filters' => $filters,
        ]);
      `;
      const renders = extractInertiaRenders(source);
      expect(renders).toHaveLength(1);
      expect(renders[0].pageName).toBe('Users/Index');
      expect(renders[0].propNames).toEqual(['users', 'filters']);
    });

    it('extracts inertia() helper calls', () => {
      const source = `return inertia('Dashboard', ['stats' => $stats]);`;
      const renders = extractInertiaRenders(source);
      expect(renders).toHaveLength(1);
      expect(renders[0].pageName).toBe('Dashboard');
      expect(renders[0].propNames).toEqual(['stats']);
    });

    it('extracts render with no props', () => {
      const source = `return Inertia::render('Welcome');`;
      const renders = extractInertiaRenders(source);
      expect(renders).toHaveLength(1);
      expect(renders[0].pageName).toBe('Welcome');
      expect(renders[0].propNames).toEqual([]);
    });

    it('extracts multiple render calls', () => {
      const source = `
        Inertia::render('Users/Index', ['users' => $users]);
        Inertia::render('Users/Show', ['user' => $user]);
      `;
      const renders = extractInertiaRenders(source);
      expect(renders).toHaveLength(2);
    });
  });

  describe('resolvePagePath()', () => {
    it('resolves page name to Vue file path', () => {
      expect(resolvePagePath('Users/Index')).toBe('resources/js/Pages/Users/Index.vue');
    });

    it('resolves single segment page', () => {
      expect(resolvePagePath('Dashboard')).toBe('resources/js/Pages/Dashboard.vue');
    });
  });

  describe('manifest', () => {
    it('has correct name and dependencies', () => {
      expect(plugin.manifest.name).toBe('inertia');
      expect(plugin.manifest.dependencies).toEqual(['laravel', 'vue-framework']);
    });
  });
});
