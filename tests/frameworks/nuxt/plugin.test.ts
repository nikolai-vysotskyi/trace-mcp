import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import {
  NuxtPlugin,
  filePathToRoute,
  serverApiToRoute,
  extractFetchCalls,
} from '../../../src/indexer/plugins/framework/nuxt/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/nuxt3');

describe('NuxtPlugin', () => {
  let plugin: NuxtPlugin;

  beforeEach(() => {
    plugin = new NuxtPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has nuxt', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        packageJson: { dependencies: { nuxt: '^3.10.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when nuxt.config.ts exists', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-Nuxt project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-12345',
        packageJson: { dependencies: { react: '^18.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns expected edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('nuxt_auto_imports');
      expect(names).toContain('api_calls');
    });

    it('all edge types have nuxt category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('nuxt');
      }
    });
  });

  describe('filePathToRoute()', () => {
    it('converts pages/index.vue to /', () => {
      expect(filePathToRoute('pages/index.vue')).toBe('/');
    });

    it('converts pages/users.vue to /users', () => {
      expect(filePathToRoute('pages/users.vue')).toBe('/users');
    });

    it('converts pages/users/index.vue to /users', () => {
      expect(filePathToRoute('pages/users/index.vue')).toBe('/users');
    });

    it('converts pages/users/[id].vue to /users/:id', () => {
      expect(filePathToRoute('pages/users/[id].vue')).toBe('/users/:id');
    });

    it('converts pages/[...slug].vue to /:slug(.*)*', () => {
      expect(filePathToRoute('pages/[...slug].vue')).toBe('/:slug(.*)*');
    });

    it('handles nested dynamic routes', () => {
      expect(filePathToRoute('pages/posts/[postId]/comments/[id].vue'))
        .toBe('/posts/:postId/comments/:id');
    });
  });

  describe('serverApiToRoute()', () => {
    it('extracts GET method from .get.ts suffix', () => {
      const result = serverApiToRoute('server/api/users.get.ts');
      expect(result.method).toBe('GET');
      expect(result.uri).toBe('/api/users');
    });

    it('extracts POST method from .post.ts suffix', () => {
      const result = serverApiToRoute('server/api/users.post.ts');
      expect(result.method).toBe('POST');
      expect(result.uri).toBe('/api/users');
    });

    it('defaults to GET when no method suffix', () => {
      const result = serverApiToRoute('server/api/health.ts');
      expect(result.method).toBe('GET');
      expect(result.uri).toBe('/api/health');
    });
  });

  describe('extractFetchCalls()', () => {
    it('extracts useFetch URLs', () => {
      const source = `const { data } = await useFetch('/api/users');`;
      expect(extractFetchCalls(source)).toEqual(['/api/users']);
    });

    it('extracts useAsyncData URLs', () => {
      const source = `const { data } = await useAsyncData('/api/posts');`;
      expect(extractFetchCalls(source)).toEqual(['/api/posts']);
    });
  });

  describe('extractNodes()', () => {
    it('creates route for page file', () => {
      const result = plugin.extractNodes(
        'pages/users/[id].vue',
        Buffer.from('<template><div></div></template>'),
        'vue',
      );
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.routes).toHaveLength(1);
      expect(parsed.routes![0].uri).toBe('/users/:id');
      expect(parsed.frameworkRole).toBe('nuxt_page');
    });

    it('creates route for server API file', () => {
      const result = plugin.extractNodes(
        'server/api/users.get.ts',
        Buffer.from('export default defineEventHandler(() => [])'),
        'typescript',
      );
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.routes).toHaveLength(1);
      expect(parsed.routes![0].method).toBe('GET');
      expect(parsed.routes![0].uri).toBe('/api/users');
    });
  });

  describe('manifest', () => {
    it('has correct name and dependencies', () => {
      expect(plugin.manifest.name).toBe('nuxt');
      expect(plugin.manifest.dependencies).toEqual(['vue-framework']);
    });
  });
});
