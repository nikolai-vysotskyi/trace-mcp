import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  NextJSPlugin,
  appRouterPathToRoute,
  pagesRouterPathToRoute,
} from '../../../src/indexer/plugins/integration/framework/nextjs/index.js';
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
      expect(names).toContain('next_parallel_slot');
      expect(names).toContain('next_intercepting');
      expect(names).toContain('next_data_fetching');
      expect(names).toContain('next_template');
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

    it('strips @parallel slot segments from route', () => {
      expect(appRouterPathToRoute('app/dashboard/@analytics/page.tsx')).toBe('/dashboard');
    });

    it('strips intercepting route segments from route', () => {
      expect(appRouterPathToRoute('app/feed/(..photos)/[id]/page.tsx')).toBe('/feed/:id');
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

    describe('parallel routes', () => {
      it('detects parallel route slot in @folder page', () => {
        const result = plugin.extractNodes(
          'app/dashboard/@analytics/page.tsx',
          Buffer.from('export default function AnalyticsSlot() { return <div/>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_page');
        expect(parsed.metadata?.parallelSlot).toBe('analytics');
        // Route should be the parent route (without @analytics)
        expect(parsed.routes![0].uri).toBe('/dashboard');
      });

      it('detects default.tsx as parallel route fallback', () => {
        const result = plugin.extractNodes(
          'app/dashboard/@analytics/default.tsx',
          Buffer.from('export default function Default() { return null; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_default');
        expect(parsed.metadata?.parallelSlot).toBe('analytics');
      });
    });

    describe('intercepting routes', () => {
      it('detects (..) intercepting route pattern', () => {
        const result = plugin.extractNodes(
          'app/feed/(..photos)/[id]/page.tsx',
          Buffer.from('export default function InterceptedPhoto() { return <div/>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_page');
        expect(parsed.metadata?.intercepting).toBe(true);
        expect(parsed.metadata?.interceptPattern).toBe('..');
        expect(parsed.metadata?.interceptedRoute).toBe('/photos/:id');
      });

      it('detects (.) same-level intercepting route', () => {
        const result = plugin.extractNodes(
          'app/photos/(.)detail/page.tsx',
          Buffer.from('export default function Page() { return <div/>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.intercepting).toBe(true);
        expect(parsed.metadata?.interceptPattern).toBe('.');
        expect(parsed.metadata?.interceptedRoute).toBe('/detail');
      });

      it('detects (...) root-level intercepting route', () => {
        const result = plugin.extractNodes(
          'app/feed/(...photos)/page.tsx',
          Buffer.from('export default function Page() { return <div/>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.intercepting).toBe(true);
        expect(parsed.metadata?.interceptPattern).toBe('...');
        expect(parsed.metadata?.interceptedRoute).toBe('/photos');
      });
    });

    describe('Pages Router data fetching', () => {
      it('detects getStaticProps', () => {
        const source = `
export async function getStaticProps() {
  return { props: { title: 'About' } };
}
export default function About({ title }) { return <div>{title}</div>; }
`;
        const result = plugin.extractNodes('pages/about.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_page');
        expect(parsed.metadata?.dataFetching).toContain('getStaticProps');
      });

      it('detects getServerSideProps', () => {
        const source = `
export async function getServerSideProps(context) {
  return { props: { data: [] } };
}
export default function Page({ data }) { return <div/>; }
`;
        const result = plugin.extractNodes('pages/dynamic.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.dataFetching).toContain('getServerSideProps');
      });

      it('detects getStaticPaths', () => {
        const source = `
export async function getStaticPaths() {
  return { paths: [], fallback: false };
}
export async function getStaticProps({ params }) {
  return { props: { id: params.id } };
}
export default function Post({ id }) { return <div>{id}</div>; }
`;
        const result = plugin.extractNodes('pages/posts/[id].tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.dataFetching).toContain('getStaticPaths');
        expect(parsed.metadata?.dataFetching).toContain('getStaticProps');
      });

      it('does not detect data fetching in pages/api/ files', () => {
        const source = `
export default function handler(req, res) { res.json({}); }
`;
        const result = plugin.extractNodes('pages/api/users.ts', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_api_page');
        expect(parsed.metadata?.dataFetching).toBeUndefined();
      });
    });

    describe('template.tsx handling', () => {
      it('detects template files', () => {
        const result = plugin.extractNodes(
          'app/dashboard/template.tsx',
          Buffer.from('export default function Template({ children }) { return <div>{children}</div>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_template');
      });
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('nextjs');
      expect(plugin.manifest.priority).toBe(15);
    });
  });
});
