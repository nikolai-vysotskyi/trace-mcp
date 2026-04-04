import { describe, it, expect, beforeEach } from 'vitest';
import {
  HonoPlugin,
  extractHonoRoutes,
  extractHonoMiddleware,
} from '../../../src/indexer/plugins/integration/framework/hono/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

describe('HonoPlugin', () => {
  let plugin: HonoPlugin;

  beforeEach(() => {
    plugin = new HonoPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has hono in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent',
        packageJson: { dependencies: { hono: '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when hono is in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent',
        packageJson: { devDependencies: { hono: '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-Hono project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-12345',
        packageJson: { dependencies: { express: '^4.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns hono_route and hono_middleware edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('hono_route');
      expect(names).toContain('hono_middleware');
    });

    it('all edge types have hono category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('hono');
      }
    });
  });

  describe('extractHonoRoutes()', () => {
    it('extracts app.get route', () => {
      const source = `
        const app = new Hono();
        app.get('/users', (c) => c.json([]));
      `;
      const routes = extractHonoRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('GET');
      expect(routes[0].path).toBe('/users');
    });

    it('extracts app.post route', () => {
      const source = `
        app.post('/users', async (c) => {
          const body = await c.req.json();
          return c.json(body, 201);
        });
      `;
      const routes = extractHonoRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('POST');
      expect(routes[0].path).toBe('/users');
    });

    it('extracts app.put route', () => {
      const source = `app.put('/users/:id', async (c) => c.json({}));`;
      const routes = extractHonoRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('PUT');
      expect(routes[0].path).toBe('/users/:id');
    });

    it('extracts app.delete route', () => {
      const source = `app.delete('/users/:id', async (c) => c.text('deleted'));`;
      const routes = extractHonoRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('DELETE');
      expect(routes[0].path).toBe('/users/:id');
    });

    it('extracts app.all route', () => {
      const source = `app.all('/proxy/*', async (c) => c.text('proxied'));`;
      const routes = extractHonoRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('ALL');
      expect(routes[0].path).toBe('/proxy/*');
    });

    it('extracts app.on("METHOD", "/path") route', () => {
      const source = `
        app.on('GET', '/custom', (c) => c.text('ok'));
        app.on('POST', '/custom', (c) => c.text('created'));
      `;
      const routes = extractHonoRoutes(source);
      expect(routes).toHaveLength(2);
      expect(routes[0].method).toBe('GET');
      expect(routes[0].path).toBe('/custom');
      expect(routes[1].method).toBe('POST');
      expect(routes[1].path).toBe('/custom');
    });

    it('extracts route group app.route("/api", subApp)', () => {
      const source = `
        const apiRoutes = new Hono();
        apiRoutes.get('/users', (c) => c.json([]));
        app.route('/api', apiRoutes);
      `;
      const routes = extractHonoRoutes(source);
      // Should get the GET /users and the route group mount
      const routeGroup = routes.find((r) => r.method === 'USE');
      expect(routeGroup).toBeDefined();
      expect(routeGroup!.path).toBe('/api');
    });

    it('extracts multiple routes of different methods', () => {
      const source = `
        app.get('/items', (c) => c.json([]));
        app.post('/items', (c) => c.json({}));
        app.put('/items/:id', (c) => c.json({}));
        app.delete('/items/:id', (c) => c.text(''));
      `;
      const routes = extractHonoRoutes(source);
      expect(routes).toHaveLength(4);
      const methods = routes.map((r) => r.method);
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');
      expect(methods).toContain('PUT');
      expect(methods).toContain('DELETE');
    });

    it('returns empty array for source with no routes', () => {
      const source = `
        const x = 42;
        console.log('hello');
      `;
      const routes = extractHonoRoutes(source);
      expect(routes).toHaveLength(0);
    });
  });

  describe('extractHonoMiddleware()', () => {
    it('extracts path-scoped middleware', () => {
      const source = `
        app.use('/api/*', cors());
      `;
      const mw = extractHonoMiddleware(source);
      expect(mw).toHaveLength(1);
      expect(mw[0].path).toBe('/api/*');
      expect(mw[0].name).toBe('cors()');
    });

    it('extracts global middleware (no path)', () => {
      const source = `
        app.use(logger());
      `;
      const mw = extractHonoMiddleware(source);
      const global = mw.find((m) => m.path === null);
      expect(global).toBeDefined();
      expect(global!.name).toBe('logger()');
    });

    it('extracts multiple middleware calls', () => {
      const source = `
        app.use(logger());
        app.use('/api/*', cors());
        app.use('/auth/*', bearerAuth({ token: 'secret' }));
      `;
      const mw = extractHonoMiddleware(source);
      expect(mw.length).toBeGreaterThanOrEqual(3);
    });

    it('returns empty array when no middleware present', () => {
      const source = `app.get('/test', (c) => c.text('ok'));`;
      const mw = extractHonoMiddleware(source);
      expect(mw).toHaveLength(0);
    });
  });

  describe('extractNodes()', () => {
    it('sets frameworkRole to hono_route and populates routes', () => {
      const source = `
        app.get('/users', (c) => c.json([]));
        app.post('/users', (c) => c.json({}));
      `;
      const result = plugin.extractNodes('routes.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('hono_route');
      expect(parsed.routes).toHaveLength(2);
      expect(parsed.routes![0].method).toBe('GET');
      expect(parsed.routes![0].uri).toBe('/users');
    });

    it('sets frameworkRole to hono_middleware when only middleware present', () => {
      const source = `
        app.use(logger());
      `;
      const result = plugin.extractNodes('middleware.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('hono_middleware');
    });

    it('routes take priority over middleware for frameworkRole', () => {
      const source = `
        app.use(logger());
        app.get('/test', (c) => c.text('ok'));
      `;
      const result = plugin.extractNodes('mixed.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('hono_route');
    });

    it('returns empty result for non-hono source', () => {
      const source = `
        const x = 42;
        console.log('hello');
      `;
      const result = plugin.extractNodes('plain.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.routes).toHaveLength(0);
      expect(parsed.frameworkRole).toBeUndefined();
    });

    it('skips non-typescript/javascript files', () => {
      const source = `app.get('/test', handler)`;
      const result = plugin.extractNodes('test.rb', Buffer.from(source), 'ruby');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.symbols).toHaveLength(0);
      expect(parsed.routes).toBeUndefined();
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('hono');
      expect(plugin.manifest.priority).toBe(25);
    });
  });
});
