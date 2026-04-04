import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  NestJSPlugin,
  extractControllerRoutes,
  extractModuleInfo,
  extractConstructorDeps,
} from '../../../src/indexer/plugins/integration/framework/nestjs/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/nestjs-basic');

describe('NestJSPlugin', () => {
  let plugin: NestJSPlugin;

  beforeEach(() => {
    plugin = new NestJSPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has @nestjs/core', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        packageJson: { dependencies: { '@nestjs/core': '^10.0.0' } },
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

    it('returns false for non-NestJS project', () => {
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
      expect(names).toContain('nest_module_imports');
      expect(names).toContain('nest_provides');
      expect(names).toContain('nest_injects');
      expect(names).toContain('nest_guards');
      expect(names).toContain('nest_pipes');
      expect(names).toContain('nest_interceptors');
    });

    it('all edge types have nestjs category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('nestjs');
      }
    });
  });

  describe('extractControllerRoutes()', () => {
    it('extracts routes from controller with base path', () => {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/users/users.controller.ts'),
        'utf-8',
      );
      const { basePath, routes, guards } = extractControllerRoutes(source, 'users.controller.ts');
      expect(basePath).toBe('users');
      expect(routes).toHaveLength(3);

      const methods = routes.map((r) => r.method);
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');

      const uris = routes.map((r) => r.uri);
      expect(uris).toContain('/users');
      expect(uris).toContain('/users/:id');
    });

    it('extracts guards', () => {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/users/users.controller.ts'),
        'utf-8',
      );
      const { guards } = extractControllerRoutes(source, 'users.controller.ts');
      expect(guards).toContain('AuthGuard');
    });
  });

  describe('extractModuleInfo()', () => {
    it('extracts module imports and providers', () => {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/users/users.module.ts'),
        'utf-8',
      );
      const info = extractModuleInfo(source);
      expect(info).not.toBeNull();
      expect(info!.controllers).toContain('UsersController');
      expect(info!.providers).toContain('UsersService');
    });

    it('extracts root module imports', () => {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/app.module.ts'),
        'utf-8',
      );
      const info = extractModuleInfo(source);
      expect(info).not.toBeNull();
      expect(info!.imports).toContain('UsersModule');
    });
  });

  describe('extractConstructorDeps()', () => {
    it('extracts constructor injection types', () => {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/users/users.controller.ts'),
        'utf-8',
      );
      const deps = extractConstructorDeps(source);
      expect(deps).toContain('UsersService');
    });
  });

  describe('extractNodes()', () => {
    it('detects controller role and routes', () => {
      const content = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/users/users.controller.ts'),
      );
      const result = plugin.extractNodes('users.controller.ts', content, 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nest_controller');
      expect(parsed.routes!.length).toBeGreaterThanOrEqual(3);
    });

    it('detects injectable role', () => {
      const content = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/users/users.service.ts'),
      );
      const result = plugin.extractNodes('users.service.ts', content, 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nest_injectable');
    });

    it('detects module role', () => {
      const content = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/app.module.ts'),
      );
      const result = plugin.extractNodes('app.module.ts', content, 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nest_module');
    });

    it('skips non-typescript files', () => {
      const result = plugin.extractNodes('test.php', Buffer.from(''), 'php');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('nestjs');
      expect(plugin.manifest.priority).toBe(25);
    });
  });
});
