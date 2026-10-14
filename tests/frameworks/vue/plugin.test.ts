import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { VueFrameworkPlugin } from '../../../src/indexer/plugins/integration/view/vue/index.js';
import type { ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';
import { _resetYieldCountForTests, getYieldCount } from '../../../src/utils/event-loop.js';

const VUE3_FIXTURE = path.resolve(__dirname, '../../fixtures/vue3-composition');

describe('VueFrameworkPlugin', () => {
  let plugin: VueFrameworkPlugin;

  beforeEach(() => {
    plugin = new VueFrameworkPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has vue in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: VUE3_FIXTURE,
        packageJson: { dependencies: { vue: '^3.4.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when packageJson has vue in devDependencies AND .vue files exist', () => {
      // VUE3_FIXTURE has .vue source files, so vue-in-devDeps still counts.
      const ctx: ProjectContext = {
        rootPath: VUE3_FIXTURE,
        packageJson: { devDependencies: { vue: '^3.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false when vue is ONLY in devDependencies and no .vue files exist', () => {
      // Tooling/library projects that depend on Vue packages as parsers
      // (not as runtime) must not be tagged as Vue projects.
      const ctx: ProjectContext = {
        rootPath: '/tmp/test',
        packageJson: { devDependencies: { vue: '^3.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('returns false when only @vue/compiler-sfc is present (parser-only signal)', () => {
      // @vue/compiler-sfc is commonly used as a Vue file parser by code-intel
      // tools that themselves are not Vue apps. Without a .vue source file,
      // this must not be tagged as a Vue project.
      const ctx: ProjectContext = {
        rootPath: '/tmp/test',
        packageJson: { devDependencies: { '@vue/compiler-sfc': '^3.5.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('returns true when @vue/compiler-sfc is paired with .vue source files', () => {
      const ctx: ProjectContext = {
        rootPath: VUE3_FIXTURE,
        packageJson: { devDependencies: { '@vue/compiler-sfc': '^3.5.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false when packageJson has no vue', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/test',
        packageJson: { dependencies: { react: '^18.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('reads package.json from rootPath as fallback', () => {
      const ctx: ProjectContext = {
        rootPath: VUE3_FIXTURE,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false when rootPath has no package.json', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-dir-12345',
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns expected edge types', () => {
      const schema = plugin.registerSchema();
      expect(schema.edgeTypes).toBeDefined();
      expect(schema.edgeTypes!.length).toBe(6);

      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('renders_component');
      expect(names).toContain('uses_composable');
      expect(names).toContain('provides_slot');
      expect(names).toContain('references_component');
      expect(names).toContain('nuxt_entry_point');
      expect(names).toContain('vue_ssr_entry');
    });

    it('all edge types have vue category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('vue');
      }
    });
  });

  describe('extractNodes()', () => {
    it('returns empty result (language plugin handles extraction)', () => {
      const result = plugin.extractNodes('test.vue', Buffer.from(''), 'vue');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toEqual([]);
    });
  });

  describe('manifest', () => {
    it('has correct name and version', () => {
      expect(plugin.manifest.name).toBe('vue-framework');
      expect(plugin.manifest.version).toBe('1.0.0');
      expect(plugin.manifest.priority).toBe(10);
    });
  });

  it('lets a health timer run during a large Vue edge pass without rebuilding the file map per component', async () => {
    const files = Array.from({ length: 400 }, (_, i) => ({
      id: i + 1,
      path: `components/Widget${i}.vue`,
      language: 'vue',
    }));
    let allFilesCalls = 0;
    const ctx: ResolveContext = {
      rootPath: VUE3_FIXTURE,
      getAllFiles: () => {
        allFilesCalls++;
        return files;
      },
      getSymbolsByFile: (id) => [
        {
          id,
          symbolId: `components/Widget${id - 1}.vue::Widget${id - 1}`,
          name: `Widget${id - 1}`,
          kind: 'class',
          fqn: null,
          metadata: { templateComponents: [], composables: [] },
        },
      ],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 1,
      readFile: () => undefined,
    };

    let settled = false;
    let timerRanBeforeCompletion = false;
    const healthTimer = new Promise<void>((resolve) =>
      setTimeout(() => {
        timerRanBeforeCompletion = !settled;
        resolve();
      }, 0),
    );
    const pass = Promise.resolve(plugin.resolveEdges(ctx)).then(() => {
      settled = true;
    });
    await healthTimer;
    await pass;

    expect(timerRanBeforeCompletion).toBe(true);
    expect(allFilesCalls).toBeLessThanOrEqual(2);
  });

  it('does not yield fair turns on unrelated files in resolveDynamicComponentRefs (TRA-2394)', async () => {
    const plugin = new VueFrameworkPlugin();
    const files = [
      { id: 1, path: 'src/components/MyCustomButton.vue', language: 'vue' },
      ...Array.from({ length: 500 }, (_, i) => ({
        id: i + 2,
        path: `data/file${i}.bin`,
        language: 'binary',
      })),
    ];

    let readFileCalls = 0;
    const ctx: any = {
      rootPath: '/tmp/test',
      getAllFiles: () => files,
      getSymbolsByFile: (id: number) =>
        id === 1
          ? [
              {
                id: 1,
                symbolId: 'src/components/MyCustomButton.vue::MyCustomButton',
                name: 'MyCustomButton',
                kind: 'class',
                fqn: null,
                metadata: { templateComponents: [], composables: [] },
              },
            ]
          : [],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 1,
      readFile: () => {
        readFileCalls++;
        return undefined;
      },
    };

    _resetYieldCountForTests();
    const result = await plugin.resolveEdges(ctx);
    expect(result.isOk()).toBe(true);
    // On pre-fix code, the 500 binary files caused an extra ~32 fair yields and 500 readFile calls
    // in resolveDynamicComponentRefs (yielding ~33 times in total).
    // With pre-filtering, the 500 binary files are never iterated or read:
    // only the 1 .vue file is processed (1 yield in vueFiles + 1 in resolveDynamicComponentRefs = 2).
    expect(getYieldCount()).toBeLessThanOrEqual(2);
    expect(readFileCalls).toBe(1);
  });

  it('restricts scanning to changeScope in incremental runs (TRA-2434)', async () => {
    const plugin = new VueFrameworkPlugin();
    const files = [
      { id: 1, path: 'src/components/A.vue', language: 'vue' },
      { id: 2, path: 'src/components/B.vue', language: 'vue' },
      { id: 3, path: 'src/components/C.vue', language: 'vue' },
      { id: 4, path: 'src/utils/helper.ts', language: 'typescript' },
    ];

    let readFileCalls = 0;
    const ctx: any = {
      rootPath: '/tmp/test',
      changeScope: {
        changedFileIds: new Set([2]),
      },
      getAllFiles: () => files,
      getSymbolsByFile: (id: number) => [
        {
          id,
          symbolId: `file${id}::Comp`,
          name: 'Comp',
          kind: 'class',
          fqn: null,
          metadata: { templateComponents: [], composables: [] },
        },
      ],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 1,
      readFile: () => {
        readFileCalls++;
        return '';
      },
    };

    _resetYieldCountForTests();
    const result = await plugin.resolveEdges(ctx);
    expect(result.isOk()).toBe(true);
    // Dynamic ref scan only scans file 2 because it's the only changed file
    expect(readFileCalls).toBe(0); // B.vue does not have distinctive names in componentNameToSymbolId to search for, or only B.vue is read if matching
    expect(getYieldCount()).toBe(0);
  });

  it('fast-paths immediately when changeScope contains no vue/ts/js files (TRA-2434)', async () => {
    const plugin = new VueFrameworkPlugin();
    const files = [
      { id: 1, path: 'src/components/A.vue', language: 'vue' },
      { id: 2, path: 'README.md', language: 'markdown' },
    ];

    let getSymbolsCalls = 0;
    const ctx: any = {
      rootPath: '/tmp/test',
      changeScope: {
        changedFileIds: new Set([2]), // Only README.md changed
      },
      getAllFiles: () => files,
      getSymbolsByFile: () => {
        getSymbolsCalls++;
        return [];
      },
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 1,
      readFile: () => '',
    };

    const result = await plugin.resolveEdges(ctx);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
    expect(getSymbolsCalls).toBe(0);
  });
});
