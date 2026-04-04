import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { VueFrameworkPlugin } from '../../../src/indexer/plugins/integration/vue/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

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

    it('returns true when packageJson has vue in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/test',
        packageJson: { devDependencies: { vue: '^3.0.0' } },
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
      expect(schema.edgeTypes!.length).toBe(3);

      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('renders_component');
      expect(names).toContain('uses_composable');
      expect(names).toContain('provides_slot');
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
});
