import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { VueFrameworkPlugin } from '../../../src/indexer/plugins/integration/view/vue/index.js';
import type { ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';

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
});
