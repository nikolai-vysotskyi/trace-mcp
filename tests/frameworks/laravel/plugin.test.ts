import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { LaravelPlugin } from '../../../src/indexer/plugins/framework/laravel/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const L10_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-10');
const L12_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-12');
const NO_FW_FIXTURE = path.resolve(__dirname, '../../fixtures/no-framework');

describe('LaravelPlugin', () => {
  const plugin = new LaravelPlugin();

  describe('detect()', () => {
    it('returns true for Laravel 10 project', () => {
      const ctx: ProjectContext = {
        rootPath: L10_FIXTURE,
        composerJson: {
          require: { 'laravel/framework': '^10.0' },
        },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true for Laravel 12 project', () => {
      const ctx: ProjectContext = {
        rootPath: L12_FIXTURE,
        composerJson: {
          require: { 'laravel/framework': '^12.0' },
        },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-Laravel project', () => {
      const ctx: ProjectContext = {
        rootPath: NO_FW_FIXTURE,
        composerJson: {},
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('detects from disk when composerJson not in context', () => {
      const ctx: ProjectContext = {
        rootPath: L10_FIXTURE,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false when no composer.json exists', () => {
      const ctx: ProjectContext = {
        rootPath: '/nonexistent/path',
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns all expected edge types', () => {
      const schema = plugin.registerSchema();
      const edgeNames = schema.edgeTypes!.map((e) => e.name);

      expect(edgeNames).toContain('routes_to');
      expect(edgeNames).toContain('has_many');
      expect(edgeNames).toContain('belongs_to');
      expect(edgeNames).toContain('belongs_to_many');
      expect(edgeNames).toContain('has_one');
      expect(edgeNames).toContain('morphs_to');
      expect(edgeNames).toContain('validates_with');
      expect(edgeNames).toContain('dispatches');
      expect(edgeNames).toContain('listens_to');
      expect(edgeNames).toContain('middleware_guards');
      expect(edgeNames).toContain('migrates');
    });

    it('all edge types have laravel category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('laravel');
      }
    });
  });

  describe('manifest', () => {
    it('has correct name and version', () => {
      expect(plugin.manifest.name).toBe('laravel');
      expect(plugin.manifest.version).toBe('1.0.0');
    });
  });
});
