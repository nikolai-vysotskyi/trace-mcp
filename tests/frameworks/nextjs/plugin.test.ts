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

      it('detects (..)(..) two-levels-up intercepting route', () => {
        const result = plugin.extractNodes(
          'app/dashboard/settings/(..)(..)photos/[id]/page.tsx',
          Buffer.from('export default function Page() { return <div/>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.intercepting).toBe(true);
        expect(parsed.metadata?.interceptPattern).toBe('(..)(..)')
        expect(parsed.metadata?.interceptedRoute).toBe('/photos/:id');
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

    describe('global-not-found (v15.2+)', () => {
      it('detects global-not-found.tsx', () => {
        const result = plugin.extractNodes(
          'app/global-not-found.tsx',
          Buffer.from('export default function GlobalNotFound() { return <html><body>Not Found</body></html>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_global_not_found');
      });
    });

    describe('Pages Router special files', () => {
      it('detects _app as next_custom_app', () => {
        const result = plugin.extractNodes(
          'pages/_app.tsx',
          Buffer.from('export default function App({ Component, pageProps }) { return <Component {...pageProps} />; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_custom_app');
        expect(parsed.routes).toHaveLength(0);
      });

      it('detects _document as next_custom_document', () => {
        const result = plugin.extractNodes(
          'pages/_document.tsx',
          Buffer.from('export default function Document() { return <html><body /></html>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_custom_document');
      });

      it('detects _error as next_custom_error', () => {
        const result = plugin.extractNodes(
          'pages/_error.tsx',
          Buffer.from('export default function Error({ statusCode }) { return <div>{statusCode}</div>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_custom_error');
      });

      it('detects 404 page', () => {
        const result = plugin.extractNodes(
          'pages/404.tsx',
          Buffer.from('export default function NotFound() { return <div>404</div>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_404_page');
      });

      it('detects 500 page', () => {
        const result = plugin.extractNodes(
          'pages/500.tsx',
          Buffer.from('export default function ServerError() { return <div>500</div>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_500_page');
      });

      it('does not treat nested _app as special', () => {
        const result = plugin.extractNodes(
          'pages/admin/_app.tsx',
          Buffer.from('export default function Page() { return <div/>; }'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_page');
        expect(parsed.routes).toHaveLength(1);
      });

      it('detects getInitialProps (legacy)', () => {
        const source = `
function Page({ data }) { return <div>{data}</div>; }
Page.getInitialProps = async (ctx) => { return { data: 'hello' }; };
export default Page;
`;
        const result = plugin.extractNodes('pages/legacy.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.dataFetching).toContain('getInitialProps');
      });
    });

    describe('directives', () => {
      it('detects "use client" directive', () => {
        const source = `'use client'\nexport default function Button() { return <button/>; }`;
        const result = plugin.extractNodes('app/components/Button.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.directive).toBe('use client');
        expect(parsed.metadata?.clientComponent).toBe(true);
      });

      it('detects file-level "use server" directive', () => {
        const source = `'use server'\nexport async function createItem() {}`;
        const result = plugin.extractNodes('app/actions.ts', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_server_action');
        expect(parsed.metadata?.directive).toBe('use server');
        expect(parsed.metadata?.serverActionScope).toBe('file');
      });

      it('detects inline "use server" directive', () => {
        const source = `export default function Page() {\n  async function save() {\n    'use server'\n    await db.save();\n  }\n  return <form action={save}/>;\n}`;
        const result = plugin.extractNodes('app/page.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.serverActionScope).toBe('inline');
      });

      it('detects "use cache" directive (v16)', () => {
        const source = `'use cache'\nexport async function getData() { return fetch('/api'); }`;
        const result = plugin.extractNodes('app/data.ts', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.directive).toBe('use cache');
        expect(parsed.metadata?.cacheType).toBe('default');
      });

      it('detects "use cache: remote" variant', () => {
        const source = `'use cache: remote'\nexport async function getData() {}`;
        const result = plugin.extractNodes('app/remote.ts', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.directive).toBe('use cache: remote');
        expect(parsed.metadata?.cacheType).toBe('remote');
      });

      it('detects "use cache: private" variant', () => {
        const source = `'use cache: private'\nexport async function getPrivate() {}`;
        const result = plugin.extractNodes('app/private.ts', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.cacheType).toBe('private');
      });
    });

    describe('root-level conventions', () => {
      it('detects instrumentation-client.ts (v15+)', () => {
        const result = plugin.extractNodes(
          'instrumentation-client.ts',
          Buffer.from('console.log("client instrumentation");'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_instrumentation_client');
      });

      it('detects mdx-components.tsx', () => {
        const source = `export function useMDXComponents(components) { return { ...components }; }`;
        const result = plugin.extractNodes('mdx-components.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_mdx_components');
      });

      it('detects next.config.js', () => {
        const source = `/** @type {import('next').NextConfig} */\nmodule.exports = { reactStrictMode: true };`;
        const result = plugin.extractNodes('next.config.js', Buffer.from(source), 'javascript');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_config');
      });

      it('detects next.config.mjs', () => {
        const source = `export default { reactStrictMode: true };`;
        const result = plugin.extractNodes('next.config.mjs', Buffer.from(source), 'javascript');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_config');
      });

      it('detects next.config.ts', () => {
        const source = `import type { NextConfig } from 'next';\nconst config: NextConfig = {};\nexport default config;`;
        const result = plugin.extractNodes('next.config.ts', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_config');
      });

      it('extracts middleware config.matcher', () => {
        const source = `
export function middleware(request) { return NextResponse.next(); }
export const config = { matcher: ['/dashboard/:path*', '/api/:path*'] };
`;
        const result = plugin.extractNodes('middleware.ts', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_middleware');
        expect(parsed.metadata?.matcher).toBeDefined();
      });

      it('detects proxy.ts (v16)', () => {
        const source = `export function proxy(request) { return NextResponse.next(); }`;
        const result = plugin.extractNodes('proxy.ts', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_middleware');
      });

      it('detects src/ prefixed root files', () => {
        const result = plugin.extractNodes(
          'src/middleware.ts',
          Buffer.from('export function middleware() {}'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_middleware');
      });
    });

    describe('App Router export conventions', () => {
      it('detects generateStaticParams', () => {
        const source = `
export async function generateStaticParams() { return [{ id: '1' }]; }
export default function Page({ params }) { return <div/>; }
`;
        const result = plugin.extractNodes('app/posts/[id]/page.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.dataFetching).toContain('generateStaticParams');
      });

      it('detects dynamic generateMetadata', () => {
        const source = `
export async function generateMetadata({ params }) { return { title: 'Post' }; }
export default function Page() { return <div/>; }
`;
        const result = plugin.extractNodes('app/posts/[id]/page.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.hasMetadata).toBe(true);
        expect(parsed.metadata?.metadataType).toBe('dynamic');
      });

      it('detects static metadata export', () => {
        const source = `
export const metadata = { title: 'Home', description: 'Welcome' };
export default function Page() { return <div/>; }
`;
        const result = plugin.extractNodes('app/page.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.hasMetadata).toBe(true);
        expect(parsed.metadata?.metadataType).toBe('static');
      });

      it('detects generateViewport (v14+)', () => {
        const source = `
export async function generateViewport() { return { themeColor: 'black' }; }
export default function Layout({ children }) { return <div>{children}</div>; }
`;
        const result = plugin.extractNodes('app/layout.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.hasViewport).toBe(true);
        expect(parsed.metadata?.viewportType).toBe('dynamic');
      });

      it('detects static viewport export', () => {
        const source = `
export const viewport = { themeColor: 'black', width: 'device-width' };
export default function Layout({ children }) { return <div>{children}</div>; }
`;
        const result = plugin.extractNodes('app/layout.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.metadata?.hasViewport).toBe(true);
        expect(parsed.metadata?.viewportType).toBe('static');
      });

      it('detects route segment config exports', () => {
        const source = `
export const dynamic = 'force-dynamic';
export const runtime = 'edge';
export const revalidate = 60;
export const preferredRegion = 'iad1';
export default function Page() { return <div/>; }
`;
        const result = plugin.extractNodes('app/dashboard/page.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        const config = parsed.metadata?.routeSegmentConfig as Record<string, string>;
        expect(config.dynamic).toBe('force-dynamic');
        expect(config.runtime).toBe('edge');
        expect(config.revalidate).toBe('60');
        expect(config.preferredRegion).toBe('iad1');
      });

      it('detects generateSitemaps', () => {
        const source = `
export async function generateSitemaps() { return [{ id: 0 }, { id: 1 }]; }
export default function sitemap({ id }) { return []; }
`;
        const result = plugin.extractNodes('app/sitemap.ts', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().metadata?.generatesSitemaps).toBe(true);
      });

      it('detects generateImageMetadata', () => {
        const source = `
export async function generateImageMetadata() { return [{ id: 'og', alt: 'OG' }]; }
export default function Image({ id }) { return new ImageResponse(<div/>); }
`;
        const result = plugin.extractNodes('app/opengraph-image.tsx', Buffer.from(source), 'typescript');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().metadata?.generatesImageMetadata).toBe(true);
      });
    });

    describe('static metadata files', () => {
      it('detects favicon.ico in app/', () => {
        const result = plugin.extractNodes('app/favicon.ico', Buffer.from(''), 'other');
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_static_metadata');
        expect(parsed.metadata?.staticMetadataFile).toBe('favicon.ico');
      });

      it('detects opengraph-image.png in app/', () => {
        const result = plugin.extractNodes('app/blog/opengraph-image.png', Buffer.from(''), 'other');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_static_metadata');
      });

      it('detects sitemap.xml in app/', () => {
        const result = plugin.extractNodes('app/sitemap.xml', Buffer.from(''), 'xml');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_static_metadata');
      });

      it('detects robots.txt in app/', () => {
        const result = plugin.extractNodes('app/robots.txt', Buffer.from(''), 'other');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_static_metadata');
      });

      it('detects manifest.json in app/', () => {
        const result = plugin.extractNodes('app/manifest.json', Buffer.from('{}'), 'json');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_static_metadata');
      });

      it('detects manifest.webmanifest in app/', () => {
        const result = plugin.extractNodes('app/manifest.webmanifest', Buffer.from('{}'), 'json');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_static_metadata');
      });

      it('detects twitter-image.jpg', () => {
        const result = plugin.extractNodes('app/twitter-image.jpg', Buffer.from(''), 'other');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_static_metadata');
      });

      it('does not match static metadata outside app/', () => {
        const result = plugin.extractNodes('public/favicon.ico', Buffer.from(''), 'other');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBeUndefined();
      });

      it('supports src/app/ prefix', () => {
        const result = plugin.extractNodes('src/app/favicon.ico', Buffer.from(''), 'other');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().frameworkRole).toBe('next_static_metadata');
      });
    });

    describe('extractApiMethods', () => {
      it('returns empty array when no HTTP exports found', () => {
        const result = plugin.extractNodes(
          'app/api/test/route.ts',
          Buffer.from('export default function handler() {}'),
          'typescript',
        );
        expect(result.isOk()).toBe(true);
        const parsed = result._unsafeUnwrap();
        expect(parsed.frameworkRole).toBe('next_api_route');
        expect(parsed.routes).toHaveLength(0);
      });
    });
  });

  describe('pagesRouterPathToRoute()', () => {
    it('handles optional catch-all [[...slug]]', () => {
      expect(pagesRouterPathToRoute('pages/shop/[[...slug]].tsx')).toBe('/shop/:slug*');
    });
  });

  describe('registerSchema()', () => {
    it('includes new edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('next_renders_loading');
      expect(names).toContain('next_renders_error');
      expect(names).toContain('next_renders_not_found');
      expect(names).toContain('next_global_not_found');
      expect(names).toContain('next_instrumentation_client');
      expect(names).toContain('next_mdx_components');
      expect(names).toContain('next_config');
      expect(names).toContain('next_custom_app');
      expect(names).toContain('next_custom_document');
      expect(names).toContain('next_custom_error');
      expect(names).toContain('next_404_page');
      expect(names).toContain('next_500_page');
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('nextjs');
      expect(plugin.manifest.priority).toBe(15);
    });
  });
});
