import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LaravelPlugin } from '../../../src/indexer/plugins/integration/framework/laravel/index.js';
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

    it('all edge types have a recognised Laravel ecosystem category', () => {
      const ALLOWED = new Set([
        'laravel',
        'livewire',
        'filament',
        'nova',
        'blade',
        'pennant',
        'broadcasting',
        'laravel-data',
        'horizon',
        'cashier',
        'scout',
        'socialite',
        'medialibrary',
      ]);
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(ALLOWED.has(et.category), `unexpected category: ${et.category}`).toBe(true);
      }
    });
  });

  describe('manifest', () => {
    it('has correct name and version', () => {
      expect(plugin.manifest.name).toBe('laravel');
      expect(plugin.manifest.version).toBe('1.0.0');
    });
  });

  describe('resolveEdges() and composer discovery (TRA-2351)', () => {
    it('resolves composer.json package discovery without quadratic file scans', async () => {
      const composerJsonContent = JSON.stringify({
        name: 'test/package',
        extra: {
          laravel: {
            providers: ['App\\Providers\\TestServiceProvider'],
            aliases: { TestFacade: 'App\\Facades\\TestFacade' },
          },
        },
      });

      const mockFiles = [
        { id: 1, path: 'composer.json', language: 'json' },
        ...Array.from({ length: 50 }, (_, i) => ({
          id: i + 2,
          path: `app/File${i}.php`,
          language: 'php',
        })),
      ];

      const mockCtx: any = {
        rootPath: '/dummy',
        getAllFiles: () => mockFiles,
        getSymbolsByFile: (_fileId: number) => [],
        getSymbolByFqn: (fqn: string) => {
          if (fqn === 'App\\Providers\\TestServiceProvider') {
            return { id: 101, symbolId: 'sym:101', name: 'TestServiceProvider', kind: 'class' };
          }
          if (fqn === 'App\\Facades\\TestFacade') {
            return { id: 102, symbolId: 'sym:102', name: 'TestFacade', kind: 'class' };
          }
          return undefined;
        },
        readFile: (filePath: string) => (filePath === 'composer.json' ? composerJsonContent : ''),
      };

      const result = await plugin.resolveEdges(mockCtx);
      expect(result.isOk()).toBe(true);
      const edges = result._unsafeUnwrap();

      expect(edges.length).toBe(2);
      expect(edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceRefId: 1,
            targetRefId: 101,
            edgeType: 'references',
            metadata: expect.objectContaining({
              registration: 'provider',
              via: 'composer_laravel_discovery',
              fqn: 'App\\Providers\\TestServiceProvider',
            }),
          }),
          expect.objectContaining({
            sourceRefId: 1,
            targetRefId: 102,
            edgeType: 'references',
            metadata: expect.objectContaining({
              registration: 'alias',
              via: 'composer_laravel_discovery',
              fqn: 'App\\Facades\\TestFacade',
            }),
          }),
        ]),
      );
    });

    it('prefers local package match over foreign fork match upon FQN collision', async () => {
      // Repro case from Reviewer E: composer.json in vendor/forked/package/
      // has same provider FQN as vendor/other/package/.
      const composerJsonContent = JSON.stringify({
        name: 'forked/package',
        extra: {
          laravel: {
            providers: ['Vendor\\Shared\\ServiceProvider'],
          },
        },
      });

      const mockFiles = [
        { id: 1, path: 'vendor/forked/package/composer.json', language: 'json' },
        { id: 2, path: 'vendor/forked/package/src/ServiceProvider.php', language: 'php' },
        { id: 3, path: 'vendor/other/package/src/ServiceProvider.php', language: 'php' },
      ];

      const mockCtx: any = {
        rootPath: '/dummy',
        getAllFiles: () => mockFiles,
        getSymbolsByFile: (fileId: number) => {
          if (fileId === 2) {
            return [
              {
                id: 201,
                symbolId: 'sym:201',
                name: 'ServiceProvider',
                kind: 'class',
                fqn: 'Vendor\\Shared\\ServiceProvider',
              },
            ];
          }
          if (fileId === 3) {
            return [
              {
                id: 301,
                symbolId: 'sym:301',
                name: 'ServiceProvider',
                kind: 'class',
                fqn: 'Vendor\\Shared\\ServiceProvider',
              },
            ];
          }
          return [];
        },
        // Global lookup without scope would return other package (arbitrary row in SQLite)
        getSymbolByFqn: (fqn: string) => {
          if (fqn === 'Vendor\\Shared\\ServiceProvider') {
            return {
              id: 301,
              symbolId: 'sym:301',
              name: 'ServiceProvider',
              kind: 'class',
            };
          }
          return undefined;
        },
        readFile: (filePath: string) =>
          filePath === 'vendor/forked/package/composer.json' ? composerJsonContent : '',
      };

      const result = await plugin.resolveEdges(mockCtx);
      expect(result.isOk()).toBe(true);
      const edges = result._unsafeUnwrap();

      expect(edges.length).toBe(1);
      // Must prefer the local package symbol (201), NOT the foreign one (301)
      expect(edges[0].targetRefId).toBe(201);
    });

    it('cooperatively yields to event loop during large file set resolution', async () => {
      // 35 files => should yield at index 0, 16, 32
      const files = Array.from({ length: 35 }, (_, i) => ({
        id: i + 1,
        path: `app/Dummy${i}.php`,
        language: 'php',
      }));

      let breathed = false;
      setImmediate(() => {
        breathed = true;
      });

      const mockCtx: any = {
        rootPath: '/dummy',
        getAllFiles: () => files,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        readFile: () => '<?php namespace App; class Dummy {}',
      };

      const result = await plugin.resolveEdges(mockCtx);
      expect(result.isOk()).toBe(true);
      expect(breathed).toBe(true);
    });
  });
});
