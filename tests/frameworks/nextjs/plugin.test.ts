import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  NextJSPlugin,
  appRouterPathToRoute,
  pagesRouterPathToRoute,
} from '../../../src/indexer/plugins/framework/nextjs/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/nextjs-app');

describe('NextJSPlugin', () => {
  let plugin: NextJSPlugin;

  beforeEach(() => {
    plugin = new NextJSPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has next', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        packageJson: { dependencies: { next: '^14.0.0' } },
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

    it('returns false for non-Next.js project', () => {
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
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('next_renders_page');
      expect(names).toContain('next_server_action');
      expect(names).toContain('next_middleware');
    });

    it('all edge types have nextjs category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('nextjs');
      }
    });
  });

  describe('appRouterPathToRoute()', () => {
    it('converts app/page.tsx to /', () => {
      expect(appRouterPathToRoute('app/page.tsx')).toBe('/');
    });

    it('converts app/users/page.tsx to /users', () => {
      expect(appRouterPathToRoute('app/users/page.tsx')).toBe('/users');
    });

    it('converts app/users/[id]/page.tsx to /users/:id', () => {
      expect(appRouterPathToRoute('app/users/[id]/page.tsx')).toBe('/users/:id');
    });

    it('converts app/blog/[...slug]/page.tsx to /blog/:slug*', () => {
      expect(appRouterPathToRoute('app/blog/[...slug]/page.tsx')).toBe('/blog/:slug*');
    });

    it('strips route groups from path', () => {
      expect(appRouterPathToRoute('app/(auth)/login/page.tsx')).toBe('/login');
    });

    it('handles nested dynamic routes', () => {
      expect(appRouterPathToRoute('app/posts/[postId]/comments/[id]/page.tsx'))
        .toBe('/posts/:postId/comments/:id');
    });
  });

  describe('pagesRouterPathToRoute()', () => {
    it('converts pages/index.tsx to /', () => {
      expect(pagesRouterPathToRoute('pages/index.tsx')).toBe('/');
    });

    it('converts pages/users/[id].tsx to /users/:id', () => {
      expect(pagesRouterPathToRoute('pages/users/[id].tsx')).toBe('/users/:id');
    });

    it('converts pages/api/users.ts to /api/users', () => {
      expect(pagesRouterPathToRoute('pages/api/users.ts')).toBe('/api/users');
    });
  });

  describe('extractNodes()', () => {
    it('creates route for app router page', () => {
      const result = plugin.extractNodes(
        'app/users/[id]/page.tsx',
        Buffer.from('export default function Page() { return <div/>; }'),
        'typescript',
      );
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.routes).toHaveLength(1);
      expect(parsed.routes![0].uri).toBe('/users/:id');
      expect(parsed.frameworkRole).toBe('next_page');
    });

    it('detects layout files', () => {
      const content = fs.readFileSync(
        path.join(FIXTURE_DIR, 'app/layout.tsx'),
      );
      const result = plugin.extractNodes('app/layout.tsx', content, 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('next_layout');
    });

    it('extracts API route methods', () => {
      const content = fs.readFileSync(
        path.join(FIXTURE_DIR, 'app/api/users/route.ts'),
      );
      const result = plugin.extractNodes('app/api/users/route.ts', content, 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('next_api_route');
      const methods = parsed.routes!.map((r) => r.method);
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');
    });

    it('handles dynamic routes', () => {
      const result = plugin.extractNodes(
        'app/blog/[...slug]/page.tsx',
        Buffer.from('export default function Page() { return <div/>; }'),
        'typescript',
      );
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.routes![0].uri).toBe('/blog/:slug*');
    });

    it('skips non-JS/TS files', () => {
      const result = plugin.extractNodes('test.php', Buffer.from(''), 'php');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('nextjs');
      expect(plugin.manifest.priority).toBe(15);
    });
  });
});
