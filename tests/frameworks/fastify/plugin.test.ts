import { describe, it, expect, beforeEach } from 'vitest';
import {
  FastifyPlugin,
  extractFastifyRoutes,
  extractFastifyHooks,
  extractFastifyPlugins,
} from '../../../src/indexer/plugins/framework/fastify/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

describe('FastifyPlugin', () => {
  let plugin: FastifyPlugin;

  beforeEach(() => {
    plugin = new FastifyPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has fastify', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent',
        packageJson: { dependencies: { fastify: '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when fastify is in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent',
        packageJson: { devDependencies: { fastify: '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-Fastify project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-12345',
        packageJson: { dependencies: { express: '^4.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns expected edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('fastify_route');
      expect(names).toContain('fastify_hook');
      expect(names).toContain('fastify_plugin');
    });

    it('all edge types have fastify category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('fastify');
      }
    });
  });

  describe('extractFastifyRoutes()', () => {
    it('extracts GET route via shorthand', () => {
      const source = `
        fastify.get('/users', async (request, reply) => {
          return db.users.findAll();
        });
      `;
      const routes = extractFastifyRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('GET');
      expect(routes[0].path).toBe('/users');
    });

    it('extracts POST route via shorthand', () => {
      const source = `
        app.post('/users', async (request, reply) => {
          return db.users.create(request.body);
        });
      `;
      const routes = extractFastifyRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('POST');
      expect(routes[0].path).toBe('/users');
    });

    it('extracts PUT route via shorthand', () => {
      const source = `
        server.put('/users/:id', async (request, reply) => {
          return db.users.update(request.params.id, request.body);
        });
      `;
      const routes = extractFastifyRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('PUT');
      expect(routes[0].path).toBe('/users/:id');
    });

    it('extracts DELETE route via shorthand', () => {
      const source = `
        instance.delete('/users/:id', async (request, reply) => {
          return db.users.remove(request.params.id);
        });
      `;
      const routes = extractFastifyRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('DELETE');
      expect(routes[0].path).toBe('/users/:id');
    });

    it('extracts route() object syntax', () => {
      const source = `
        fastify.route({
          method: 'GET',
          url: '/health',
          handler: async (request, reply) => {
            return { status: 'ok' };
          },
        });
      `;
      const routes = extractFastifyRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('GET');
      expect(routes[0].path).toBe('/health');
    });

    it('extracts multiple routes including both shorthand and object syntax', () => {
      const source = `
        fastify.get('/items', async () => []);
        fastify.post('/items', async () => {});
        fastify.route({ method: 'DELETE', url: '/items/:id', handler: async () => {} });
      `;
      const routes = extractFastifyRoutes(source);
      expect(routes).toHaveLength(3);
      const methods = routes.map((r) => r.method);
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');
      expect(methods).toContain('DELETE');
    });

    it('returns empty array for source with no routes', () => {
      const source = `
        const x = 42;
        console.log('hello');
      `;
      const routes = extractFastifyRoutes(source);
      expect(routes).toHaveLength(0);
    });
  });

  describe('extractFastifyHooks()', () => {
    it('extracts onRequest hook', () => {
      const source = `
        fastify.addHook('onRequest', async (request, reply) => {
          // auth check
        });
      `;
      const hooks = extractFastifyHooks(source);
      expect(hooks).toContain('onRequest');
    });

    it('extracts preHandler hook', () => {
      const source = `
        app.addHook('preHandler', async (request, reply) => {
          // validate
        });
      `;
      const hooks = extractFastifyHooks(source);
      expect(hooks).toContain('preHandler');
    });

    it('extracts multiple hooks', () => {
      const source = `
        fastify.addHook('onRequest', async () => {});
        fastify.addHook('preHandler', async () => {});
        fastify.addHook('onSend', async () => {});
        fastify.addHook('onResponse', async () => {});
      `;
      const hooks = extractFastifyHooks(source);
      expect(hooks).toHaveLength(4);
      expect(hooks).toContain('onRequest');
      expect(hooks).toContain('preHandler');
      expect(hooks).toContain('onSend');
      expect(hooks).toContain('onResponse');
    });

    it('returns empty array when no hooks present', () => {
      const source = `fastify.get('/test', async () => {});`;
      const hooks = extractFastifyHooks(source);
      expect(hooks).toHaveLength(0);
    });
  });

  describe('extractFastifyPlugins()', () => {
    it('extracts register() calls', () => {
      const source = `
        fastify.register(cors);
        fastify.register(authPlugin, { secret: 'key' });
        app.register(swagger);
      `;
      const plugins = extractFastifyPlugins(source);
      expect(plugins).toHaveLength(3);
      expect(plugins).toContain('cors');
      expect(plugins).toContain('authPlugin');
      expect(plugins).toContain('swagger');
    });

    it('returns empty array when no register calls present', () => {
      const source = `
        fastify.get('/test', async () => {});
      `;
      const plugins = extractFastifyPlugins(source);
      expect(plugins).toHaveLength(0);
    });
  });

  describe('extractNodes()', () => {
    it('sets frameworkRole to fastify_route and populates routes', () => {
      const source = `
        fastify.get('/users', async () => []);
        fastify.post('/users', async () => {});
      `;
      const result = plugin.extractNodes('routes.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('fastify_route');
      expect(parsed.routes).toHaveLength(2);
      expect(parsed.routes![0].method).toBe('GET');
      expect(parsed.routes![0].uri).toBe('/users');
    });

    it('sets frameworkRole to fastify_hook when only hooks present', () => {
      const source = `
        fastify.addHook('onRequest', async () => {});
      `;
      const result = plugin.extractNodes('hooks.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('fastify_hook');
    });

    it('sets frameworkRole to fastify_plugin when only plugins present', () => {
      const source = `
        fastify.register(cors);
      `;
      const result = plugin.extractNodes('plugins.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('fastify_plugin');
    });

    it('routes take priority over hooks for frameworkRole', () => {
      const source = `
        fastify.get('/test', async () => {});
        fastify.addHook('onRequest', async () => {});
      `;
      const result = plugin.extractNodes('mixed.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('fastify_route');
    });

    it('skips non-JS/TS files', () => {
      const result = plugin.extractNodes('test.rb', Buffer.from(''), 'ruby');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('fastify');
      expect(plugin.manifest.priority).toBe(25);
    });
  });
});
