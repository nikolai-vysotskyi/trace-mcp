import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import {
  NuxtPlugin,
  filePathToRoute,
  serverApiToRoute,
  serverRoutesToRoute,
  extractFetchCalls,
} from '../../../src/indexer/plugins/integration/framework/nuxt/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/nuxt3');
const FIXTURE_DIR_V4 = path.resolve(__dirname, '../../fixtures/nuxt4');

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

  describe('Nuxt 4 detection', () => {
    it('detects Nuxt 4 from package.json version ^4', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR_V4,
        packageJson: { dependencies: { nuxt: '^4.0.0' } },
        configFiles: [],
      };
      plugin.detect(ctx);
      expect(plugin.getSrcDir()).toBe('app');
    });

    it('detects Nuxt 4 from compatibilityVersion in nuxt.config.ts', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR_V4,
        packageJson: { dependencies: { nuxt: '^3.15.0' } },
        configFiles: [],
      };
      plugin.detect(ctx);
      // nuxt4 fixture has compatibilityVersion: 4 in config
      expect(plugin.getSrcDir()).toBe('app');
    });

    it('detects Nuxt 4 from app/pages/ directory heuristic', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR_V4,
        packageJson: { dependencies: { nuxt: '^3.10.0' } },
        configFiles: [],
      };
      plugin.detect(ctx);
      expect(plugin.getSrcDir()).toBe('app');
    });

    it('detects Nuxt 3 when no v4 signals present', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        packageJson: { dependencies: { nuxt: '^3.10.0' } },
        configFiles: [],
      };
      plugin.detect(ctx);
      expect(plugin.getSrcDir()).toBe('.');
    });
  });

  describe('registerSchema()', () => {
    it('returns expected edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('nuxt_auto_imports');
      expect(names).toContain('api_calls');
      expect(names).toContain('nuxt_shared_import');
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
      expect(filePathToRoute('pages/posts/[postId]/comments/[id].vue')).toBe(
        '/posts/:postId/comments/:id',
      );
    });

    it('converts app/pages/index.vue to / with srcDir=app', () => {
      expect(filePathToRoute('app/pages/index.vue', 'app')).toBe('/');
    });

    it('converts app/pages/users/[id].vue to /users/:id with srcDir=app', () => {
      expect(filePathToRoute('app/pages/users/[id].vue', 'app')).toBe('/users/:id');
    });

    it('converts app/pages/[...slug].vue with srcDir=app', () => {
      expect(filePathToRoute('app/pages/[...slug].vue', 'app')).toBe('/:slug(.*)*');
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

  describe('serverRoutesToRoute()', () => {
    it('converts server/routes/health.ts to GET /health', () => {
      const result = serverRoutesToRoute('server/routes/health.ts');
      expect(result.method).toBe('GET');
      expect(result.uri).toBe('/health');
    });

    it('extracts POST method from .post.ts suffix', () => {
      const result = serverRoutesToRoute('server/routes/webhook.post.ts');
      expect(result.method).toBe('POST');
      expect(result.uri).toBe('/webhook');
    });

    it('handles nested routes', () => {
      const result = serverRoutesToRoute('server/routes/v1/status.ts');
      expect(result.method).toBe('GET');
      expect(result.uri).toBe('/v1/status');
    });

    it('handles index files', () => {
      const result = serverRoutesToRoute('server/routes/index.ts');
      expect(result.method).toBe('GET');
      expect(result.uri).toBe('/');
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

    it('creates route for server/routes file (no /api prefix)', () => {
      const result = plugin.extractNodes(
        'server/routes/health.ts',
        Buffer.from('export default defineEventHandler(() => ({ status: "ok" }))'),
        'typescript',
      );
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.routes).toHaveLength(1);
      expect(parsed.routes![0].method).toBe('GET');
      expect(parsed.routes![0].uri).toBe('/health');
      expect(parsed.frameworkRole).toBe('nuxt_server_route');
    });

    it('detects shared utility files', () => {
      const result = plugin.extractNodes(
        'shared/utils/format.ts',
        Buffer.from('export function formatDate(d: Date) { return d.toISOString(); }'),
        'typescript',
      );
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nuxt_shared');
    });

    it('detects shared type files', () => {
      const result = plugin.extractNodes(
        'shared/types/user.ts',
        Buffer.from('export interface User { id: number; name: string; }'),
        'typescript',
      );
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nuxt_shared');
    });

    describe('with Nuxt 4 srcDir', () => {
      beforeEach(() => {
        const ctx: ProjectContext = {
          rootPath: FIXTURE_DIR_V4,
          packageJson: { dependencies: { nuxt: '^4.0.0' } },
          configFiles: [],
        };
        plugin.detect(ctx);
      });

      it('creates route for app/pages/ file', () => {
        const result = plugin.extractNodes(
          'app/pages/users/[id].vue',
          Buffer.from('<template><div></div></template>'),
          'vue',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.routes).toHaveLength(1);
        expect(parsed.routes![0].uri).toBe('/users/:id');
        expect(parsed.frameworkRole).toBe('nuxt_page');
      });

      it('creates route for app/pages/index.vue', () => {
        const result = plugin.extractNodes(
          'app/pages/index.vue',
          Buffer.from('<template><div>Home</div></template>'),
          'vue',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.routes).toHaveLength(1);
        expect(parsed.routes![0].uri).toBe('/');
      });

      it('detects composables under app/', () => {
        const result = plugin.extractNodes(
          'app/composables/useAuth.ts',
          Buffer.from('export function useAuth() { return {}; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('nuxt_composable');
      });

      it('server/api/ stays at project root (unchanged)', () => {
        const result = plugin.extractNodes(
          'server/api/users.get.ts',
          Buffer.from('export default defineEventHandler(() => [])'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.routes).toHaveLength(1);
        expect(parsed.routes![0].uri).toBe('/api/users');
      });
    });
  });

  describe('manifest', () => {
    it('has correct name and dependencies', () => {
      expect(plugin.manifest.name).toBe('nuxt');
      expect(plugin.manifest.dependencies).toEqual(['vue-framework']);
    });
  });
});
