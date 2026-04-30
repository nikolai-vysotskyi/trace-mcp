import { describe, expect, it } from 'vitest';
import { ReactRouterPlugin } from '../../../src/indexer/plugins/integration/framework/react-router/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function ctx(deps: Record<string, string>): ProjectContext {
  return {
    rootPath: '/tmp',
    packageJson: { dependencies: deps },
    detectedVersions: [],
    allDependencies: [],
    configFiles: [],
  };
}

async function extract(
  plugin: ReactRouterPlugin,
  code: string,
  filePath = 'src/App.tsx',
  language = 'typescriptreact',
) {
  const r = await plugin.extractNodes(filePath, Buffer.from(code), language);
  if (!r.isOk()) throw new Error(JSON.stringify(r._unsafeUnwrapErr()));
  return r._unsafeUnwrap();
}

describe('ReactRouterPlugin', () => {
  const plugin = new ReactRouterPlugin();

  it('manifest', () => {
    expect(plugin.manifest.name).toBe('react-router');
    expect(plugin.manifest.category).toBe('framework');
  });

  it('detects react-router-dom', () => {
    expect(plugin.detect(ctx({ 'react-router-dom': '^6.20.0' }))).toBe(true);
    expect(plugin.detect(ctx({ react: '^18.0.0' }))).toBe(false);
  });

  it('detects @remix-run/react', () => {
    expect(plugin.detect(ctx({ '@remix-run/react': '^2.0.0' }))).toBe(true);
  });

  it('extracts routes from <Route path=...>', async () => {
    const r = await extract(
      plugin,
      `
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './Home';
import About from './About';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
      </Routes>
    </BrowserRouter>
  );
}
`,
    );
    const uris = r.routes!.map((x) => x.uri).sort();
    expect(uris).toEqual(['/', '/about']);
    const homeRoute = r.routes!.find((x) => x.uri === '/');
    expect(homeRoute?.handler).toBe('Home');
    expect(homeRoute?.metadata?.framework).toBe('react-router');
  });

  it('extracts routes from createBrowserRouter object literals', async () => {
    const r = await extract(
      plugin,
      `
import { createBrowserRouter } from 'react-router-dom';
import Dashboard from './Dashboard';

export const router = createBrowserRouter([
  { path: '/dashboard', element: <Dashboard /> },
  { path: '/users/:id', Component: UserPage },
]);
`,
    );
    const uris = r.routes!.map((x) => x.uri).sort();
    expect(uris).toContain('/dashboard');
    expect(uris).toContain('/users/:id');
    expect(r.frameworkRole).toBe('router_config');
  });

  it('extracts <Link> and navigate() edges', async () => {
    const r = await extract(
      plugin,
      `
import { Link, useNavigate } from 'react-router-dom';

export function Nav() {
  const navigate = useNavigate();
  return (
    <div>
      <Link to="/about">About</Link>
      <button onClick={() => navigate('/login')}>Login</button>
    </div>
  );
}
`,
    );
    const navEdges = r.edges!.filter((e) => e.edgeType === 'router_navigation');
    const targets = navEdges.map((e) => e.metadata?.to).sort();
    expect(targets).toEqual(['/about', '/login']);
    expect(navEdges.find((e) => e.metadata?.to === '/about')?.metadata?.kind).toBe('link');
    expect(navEdges.find((e) => e.metadata?.to === '/login')?.metadata?.kind).toBe('navigate');
  });

  it('extracts hook usage edges', async () => {
    const r = await extract(
      plugin,
      `
import { useNavigate, useLocation, useParams } from 'react-router-dom';

export function Detail() {
  const navigate = useNavigate();
  const loc = useLocation();
  const { id } = useParams();
  return null;
}
`,
    );
    const hooks = r
      .edges!.filter((e) => e.edgeType === 'uses_router_hook')
      .map((e) => e.metadata?.hook);
    expect(hooks).toContain('useNavigate');
    expect(hooks).toContain('useLocation');
    expect(hooks).toContain('useParams');
  });

  it('extracts data-route loader/action exports', async () => {
    const r = await extract(
      plugin,
      `
import { redirect } from 'react-router-dom';

export const loader = async () => {
  return { ok: true };
};

export async function action({ request }) {
  return redirect('/done');
}
`,
      'src/routes/posts.tsx',
    );
    const exports = r
      .edges!.filter((e) => e.edgeType === 'router_data_export')
      .map((e) => e.metadata?.export);
    expect(exports).toContain('loader');
    expect(exports).toContain('action');
    expect(
      r.edges!.some((e) => e.edgeType === 'router_navigation' && e.metadata?.to === '/done'),
    ).toBe(true);
  });

  it('skips files without react-router imports', async () => {
    const r = await extract(plugin, `export const x = 1;`);
    expect(r.routes ?? []).toEqual([]);
    expect(r.edges ?? []).toEqual([]);
  });

  it('captures static prefix of template-literal Link to=', async () => {
    const r = await extract(
      plugin,
      `
import { Link } from 'react-router-dom';
export function UserCard({ id }: { id: string }) {
  return <Link to={\`/users/\${id}\`}>view</Link>;
}
`,
    );
    const navEdges = r.edges!.filter((e) => e.edgeType === 'router_navigation');
    expect(navEdges.some((e) => e.metadata?.to === '/users/' && e.metadata?.kind === 'link')).toBe(
      true,
    );
  });

  it('captures Link to={"/foo"} brace form', async () => {
    const r = await extract(
      plugin,
      `
import { Link } from 'react-router-dom';
export const X = () => <Link to={"/contact"}>x</Link>;
`,
    );
    expect(
      r.edges!.some((e) => e.edgeType === 'router_navigation' && e.metadata?.to === '/contact'),
    ).toBe(true);
  });

  it('extracts redirectDocument and useFetcher data calls', async () => {
    const r = await extract(
      plugin,
      `
import { redirectDocument, useFetcher } from 'react-router-dom';

export const loader = () => redirectDocument('/legacy');

export function Comp() {
  const fetcher = useFetcher();
  fetcher.load('/api/data');
  fetcher.submit({}, { method: 'post', action: '/api/save' });
  return null;
}
`,
    );
    const targets = r
      .edges!.filter((e) => e.edgeType === 'router_navigation')
      .map((e) => ({ to: e.metadata?.to, kind: e.metadata?.kind }));
    expect(targets).toContainEqual({ to: '/legacy', kind: 'redirect' });
    expect(targets).toContainEqual({ to: '/api/data', kind: 'fetcher_load' });
    expect(targets).toContainEqual({ to: '/api/save', kind: 'fetcher_submit' });
  });

  it('emits router_outlet edge and tags file as layout', async () => {
    const r = await extract(
      plugin,
      `
import { Outlet } from 'react-router-dom';
export default function RootLayout() {
  return (
    <div>
      <header />
      <Outlet />
    </div>
  );
}
`,
      'src/routes/_layout.tsx',
    );
    expect(r.edges!.some((e) => e.edgeType === 'router_outlet')).toBe(true);
    expect(r.frameworkRole).toBe('router_layout');
    expect(r.components!.some((c) => c.kind === 'layout' && c.framework === 'react-router')).toBe(
      true,
    );
  });
});
