import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ExpressPlugin,
  extractExpressMiddleware,
  extractExpressRoutes,
} from '../../../src/indexer/plugins/integration/framework/express/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/express-basic');

describe('ExpressPlugin', () => {
  let plugin: ExpressPlugin;

  beforeEach(() => {
    plugin = new ExpressPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has express', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        packageJson: { dependencies: { express: '^4.18.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when reading package.json from disk', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-Express project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-12345',
        packageJson: { dependencies: { koa: '^2.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns expected edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('express_route');
      expect(names).toContain('express_middleware');
      expect(names).toContain('express_mounts');
    });

    it('all edge types have express category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('express');
      }
    });
  });

  describe('extractExpressRoutes()', () => {
    it('extracts app.get routes', () => {
      const source = fs.readFileSync(path.join(FIXTURE_DIR, 'src/app.ts'), 'utf-8');
      const routes = extractExpressRoutes(source);
      expect(routes.length).toBeGreaterThanOrEqual(1);
      const healthRoute = routes.find((r) => r.path === '/health');
      expect(healthRoute).toBeDefined();
      expect(healthRoute!.method).toBe('GET');
    });

    it('extracts router.get and router.post routes', () => {
      const source = fs.readFileSync(path.join(FIXTURE_DIR, 'src/routes/users.ts'), 'utf-8');
      const routes = extractExpressRoutes(source);
      expect(routes.length).toBeGreaterThanOrEqual(3);

      const methods = routes.map((r) => r.method);
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');

      const paths = routes.map((r) => r.path);
      expect(paths).toContain('/');
      expect(paths).toContain('/:id');
    });
  });

  describe('extractExpressMiddleware()', () => {
    it('extracts path-based middleware (router mounts)', () => {
      const source = fs.readFileSync(path.join(FIXTURE_DIR, 'src/app.ts'), 'utf-8');
      const middlewares = extractExpressMiddleware(source);
      const pathMiddlewares = middlewares.filter((m) => !m.isGlobal);
      expect(pathMiddlewares.length).toBeGreaterThanOrEqual(1);
      expect(pathMiddlewares.some((m) => m.path === '/api/users')).toBe(true);
    });

    it('extracts global middleware', () => {
      const source = `
        app.use(cors());
        app.use(express.json());
      `;
      const middlewares = extractExpressMiddleware(source);
      const globals = middlewares.filter((m) => m.isGlobal);
      expect(globals.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('extractNodes()', () => {
    it('detects express_router role and routes', () => {
      const content = fs.readFileSync(path.join(FIXTURE_DIR, 'src/routes/users.ts'));
      const result = plugin.extractNodes('routes/users.ts', content, 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('express_router');
      expect(parsed.routes!.length).toBeGreaterThanOrEqual(3);
    });

    it('skips non-JS/TS files', () => {
      const result = plugin.extractNodes('test.php', Buffer.from(''), 'php');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('express');
      expect(plugin.manifest.priority).toBe(25);
    });
  });
});
