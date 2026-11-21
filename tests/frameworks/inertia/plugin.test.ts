import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractInertiaRenders,
  InertiaPlugin,
  resolvePagePath,
} from '../../../src/indexer/plugins/integration/view/inertia/index.js';
import type { ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';

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

  describe('resolveEdges()', () => {
    // TRA-3135: on huge repos the executor aborts the plugin's signal once the
    // scaled timeout elapses. Without a cooperative check, the loop below kept
    // running to completion ("zombie" execution), burning event-loop ticks
    // that starved whatever framework resolver ran next.
    it('stops scanning once ctx.signal is aborted', async () => {
      const files = Array.from({ length: 10 }, (_, i) => ({
        id: i,
        path: `Controllers/C${i}.php`,
        language: 'php',
      }));
      const controller = new AbortController();
      let readCalls = 0;
      const ctx: ResolveContext = {
        rootPath: '/tmp/test',
        getAllFiles: () => files,
        getSymbolsByFile: () => [{ id: 1, symbolId: 'C', name: 'C', kind: 'class', fqn: 'C' }],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: () => {
          readCalls++;
          controller.abort();
          return `Inertia::render('Dashboard');`;
        },
        signal: controller.signal,
      };

      const result = await plugin.resolveEdges(ctx);

      expect(result.isOk()).toBe(true);
      expect(readCalls).toBeLessThan(files.length);
    });

    // TRA-3135 (Reviewer F follow-up): the abort check only stops a resolver
    // that has ALREADY blown its budget — it does nothing about why a huge,
    // mostly-irrelevant PHP corpus burns through the budget in the first
    // place. Root cause: extractInertiaRenders() unconditionally compiled and
    // ran INERTIA_RENDER_RE (a global regex) over every PHP file's full text,
    // even files with no Inertia call at all. This proves the cheap
    // `source.includes('nertia')` gate added alongside the abort check skips
    // that regex scan entirely for non-matching files, while still finding
    // the real render call and emitting its edges.
    it('skips the regex scan for PHP files that cannot contain an Inertia call', async () => {
      const NON_MATCHING_COUNT = 3000;
      const CONTROLLER_ID = NON_MATCHING_COUNT;
      const PAGE_ID = NON_MATCHING_COUNT + 1;
      const files = [
        ...Array.from({ length: NON_MATCHING_COUNT }, (_, i) => ({
          id: i,
          path: `app/Models/M${i}.php`,
          language: 'php',
        })),
        {
          id: CONTROLLER_ID,
          path: 'app/Http/Controllers/HomeController.php',
          language: 'php',
        },
        {
          id: PAGE_ID,
          path: 'resources/js/Pages/Dashboard.vue',
          language: 'vue',
        },
      ];
      const sources = new Map<number, string>(
        files.map((f) => [
          f.id,
          f.id === CONTROLLER_ID
            ? `class HomeController { public function index() { return Inertia::render('Dashboard'); } }`
            : `class M${f.id} { public function noop() { return ${f.id}; } }`,
        ]),
      );
      const ctx: ResolveContext = {
        rootPath: '/tmp/test',
        getAllFiles: () => files,
        getSymbolsByFile: (fileId) => {
          if (fileId === CONTROLLER_ID) {
            return [
              {
                id: 1,
                symbolId: 'HomeController',
                name: 'HomeController',
                kind: 'class',
                fqn: 'HomeController',
              },
            ];
          }
          if (fileId === PAGE_ID) {
            return [
              { id: 2, symbolId: 'Dashboard', name: 'Dashboard', kind: 'class', fqn: 'Dashboard' },
            ];
          }
          return [];
        },
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: (p) => {
          const file = files.find((f) => f.path === p)!;
          return sources.get(file.id);
        },
      };

      const execSpy = vi.spyOn(RegExp.prototype, 'exec');
      const result = await plugin.resolveEdges(ctx);
      const execCalls = execSpy.mock.calls.length;
      execSpy.mockRestore();

      expect(result.isOk()).toBe(true);
      // The matching file's extraction needs only a handful of exec() calls
      // (render match + its null terminator + the empty props-key scan).
      // Without the pre-check, each of the 3000 non-matching files adds its
      // own exec() call, so this would be in the thousands.
      expect(execCalls).toBeLessThan(10);
      expect(result.isOk() && result.value).toHaveLength(1);
    });
  });

  describe('manifest', () => {
    it('has correct name and dependencies', () => {
      expect(plugin.manifest.name).toBe('inertia');
      expect(plugin.manifest.dependencies).toEqual(['laravel', 'vue-framework']);
    });
  });
});
