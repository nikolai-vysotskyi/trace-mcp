/**
 * ReactRouterPlugin — detects react-router / react-router-dom and extracts:
 *   • routes from <Route path="..." element={...} /> JSX
 *   • routes from createBrowserRouter / createMemoryRouter / createHashRouter object literals
 *   • navigation edges from <Link>, <NavLink>, navigate('/...'), redirect('/...')
 *   • hook usage edges (useNavigate, useLocation, useParams, useLoaderData, ...)
 *   • data-route exports (loader, action, ErrorBoundary, shouldRevalidate)
 *
 * Covers v6 + v7 (Remix-style data routers). The plugin is text-based by design —
 * the React language plugin already produces TS/JSX symbols; this plugin layers
 * routing semantics on top.
 */
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

const KNOWN_PACKAGES = [
  'react-router',
  'react-router-dom',
  'react-router-native',
  '@remix-run/react',
];

const IMPORT_RE = /\bfrom\s+["'](?:react-router(?:-dom|-native)?|@remix-run\/react)["']/;

// <Route ...> opening tag — attributes are parsed in a second pass below.
const JSX_ROUTE_RE = /<Route\b([^>]*?)\/?>/g;
const ROUTE_PATH_ATTR_RE = /\bpath\s*=\s*["']([^"']+)["']/;
const ROUTE_ELEMENT_ATTR_RE = /\belement\s*=\s*\{[^}]*?<\s*(\w+)/;
const ROUTE_COMPONENT_ATTR_RE = /\bcomponent\s*=\s*\{?\s*(\w+)/;

// path: '/foo', element: <Foo /> | Component: Foo (object-literal route configs)
const OBJECT_ROUTE_RE =
  /\bpath\s*:\s*["']([^"']+)["'][\s\S]{0,200}?\b(?:element|Component|component)\s*:\s*(?:<\s*(\w+)|(\w+))/g;

// <Link to="/foo">, <Link to={"/foo"}>, <Link to={`/users/${id}`}> — captures the static prefix of
// template literals so we can still see "/users/" even when the rest is dynamic.
const LINK_RE = /<(?:Link|NavLink)\b[^>]*?\bto\s*=\s*\{?\s*["'`]([^"'`${]+)/g;

// navigate('/foo') | navigate(`/foo/${id}`) — typical pattern after `const navigate = useNavigate();`
const NAVIGATE_CALL_RE = /\bnavigate\s*\(\s*["'`]([^"'`${]+)/g;

// redirect('/foo') / redirectDocument('/foo') — react-router v6/v7
const REDIRECT_CALL_RE = /\bredirect(?:Document)?\s*\(\s*["'`]([^"'`${]+)/g;

// fetcher.load('/x') / fetcher.submit(data, { action: '/x' }) — useFetcher data calls
const FETCHER_LOAD_RE = /\b\w+\s*\.\s*load\s*\(\s*["'`]([^"'`${]+)/g;
const FETCHER_SUBMIT_RE = /\baction\s*:\s*["'`]([^"'`${]+)/g;

// <Outlet /> usage — emits an edge so we can connect layout files to their child routes.
const OUTLET_RE = /<Outlet\b[^>]*?\/?>/g;

const ROUTER_HOOKS = [
  'useNavigate',
  'useLocation',
  'useParams',
  'useSearchParams',
  'useMatch',
  'useMatches',
  'useNavigation',
  'useLoaderData',
  'useActionData',
  'useRouteLoaderData',
  'useRouteError',
  'useFetcher',
  'useFetchers',
  'useSubmit',
  'useFormAction',
  'useBlocker',
  'useBeforeUnload',
  'useResolvedPath',
  'useHref',
  'useInRouterContext',
  'useOutlet',
  'useOutletContext',
  'useRevalidator',
] as const;

const HOOK_CALL_RE = new RegExp(`\\b(${ROUTER_HOOKS.join('|')})\\s*\\(`, 'g');

// createBrowserRouter([...]) | createHashRouter([...]) | createMemoryRouter([...])
const CREATE_ROUTER_RE = /\bcreate(?:Browser|Hash|Memory)Router\s*\(/;

// Data-route module-level exports: export const loader = ..., export async function action(...)
const DATA_EXPORT_RE =
  /^\s*export\s+(?:async\s+)?(?:const|let|function)\s+(loader|action|ErrorBoundary|shouldRevalidate|meta|links|headers|handle)\b/gm;

export class ReactRouterPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'react-router',
    version: '1.0.0',
    priority: 50,
    category: 'framework',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };
    return KNOWN_PACKAGES.some((pkg) => pkg in deps);
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'router_navigation',
          category: 'routing',
          description: 'react-router navigation target (<Link>, navigate(), redirect())',
        },
        {
          name: 'uses_router_hook',
          category: 'routing',
          description: 'react-router hook usage (useNavigate, useLocation, useParams, …)',
        },
        {
          name: 'router_data_export',
          category: 'routing',
          description: 'react-router data-route module export (loader / action / ErrorBoundary)',
        },
        {
          name: 'router_outlet',
          category: 'routing',
          description: '<Outlet /> placeholder — file renders nested child routes',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const hasImport = IMPORT_RE.test(source);
    const hasCreateRouter = CREATE_ROUTER_RE.test(source);
    if (!hasImport && !hasCreateRouter) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: [],
      edges: [],
      components: [],
    };
    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;

    // Routes from <Route path=...>
    const seenRoutes = new Set<string>();
    for (const m of source.matchAll(JSX_ROUTE_RE)) {
      const attrs = m[1] ?? '';
      const pathMatch = attrs.match(ROUTE_PATH_ATTR_RE);
      if (!pathMatch) continue;
      const uri = pathMatch[1];
      const handler =
        attrs.match(ROUTE_ELEMENT_ATTR_RE)?.[1] ?? attrs.match(ROUTE_COMPONENT_ATTR_RE)?.[1];
      const line = findLine(m.index ?? 0);
      const key = `${uri}::${handler ?? ''}::${line}`;
      if (seenRoutes.has(key)) continue;
      seenRoutes.add(key);
      result.routes!.push({
        method: 'GET',
        uri,
        ...(handler && { handler }),
        line,
        metadata: { framework: 'react-router', source: 'jsx' },
      });
    }

    // Routes from object literals (createBrowserRouter, RouteObject[])
    for (const m of source.matchAll(OBJECT_ROUTE_RE)) {
      const uri = m[1];
      const handler = m[2] ?? m[3];
      const line = findLine(m.index ?? 0);
      const key = `${uri}::${handler ?? ''}::${line}`;
      if (seenRoutes.has(key)) continue;
      seenRoutes.add(key);
      result.routes!.push({
        method: 'GET',
        uri,
        ...(handler && { handler }),
        line,
        metadata: { framework: 'react-router', source: 'object' },
      });
    }

    // Navigation edges
    const emitNav = (kind: string, target: string, idx: number) => {
      result.edges!.push({
        edgeType: 'router_navigation',
        metadata: {
          kind,
          to: target,
          filePath,
          line: findLine(idx),
        },
      });
    };
    for (const m of source.matchAll(LINK_RE)) emitNav('link', m[1], m.index ?? 0);
    for (const m of source.matchAll(NAVIGATE_CALL_RE)) emitNav('navigate', m[1], m.index ?? 0);
    for (const m of source.matchAll(REDIRECT_CALL_RE)) emitNav('redirect', m[1], m.index ?? 0);
    for (const m of source.matchAll(FETCHER_LOAD_RE)) emitNav('fetcher_load', m[1], m.index ?? 0);
    for (const m of source.matchAll(FETCHER_SUBMIT_RE))
      emitNav('fetcher_submit', m[1], m.index ?? 0);

    // <Outlet /> — file renders child routes
    for (const m of source.matchAll(OUTLET_RE)) {
      result.edges!.push({
        edgeType: 'router_outlet',
        metadata: {
          filePath,
          line: findLine(m.index ?? 0),
        },
      });
    }

    // Hook usage
    for (const m of source.matchAll(HOOK_CALL_RE)) {
      result.edges!.push({
        edgeType: 'uses_router_hook',
        metadata: {
          hook: m[1],
          filePath,
          line: findLine(m.index ?? 0),
        },
      });
    }

    // Data-route exports (treat the file as a data route module)
    const dataExports: string[] = [];
    for (const m of source.matchAll(DATA_EXPORT_RE)) {
      dataExports.push(m[1]);
      result.edges!.push({
        edgeType: 'router_data_export',
        metadata: {
          export: m[1],
          filePath,
          line: findLine(m.index ?? 0),
        },
      });
    }

    const hasOutlet = result.edges!.some((e) => e.edgeType === 'router_outlet');

    if (dataExports.length > 0 || hasOutlet) {
      result.components!.push({
        name: filePath,
        kind: hasOutlet ? 'layout' : 'page',
        framework: 'react-router',
        props: { dataExports, hasOutlet },
      });
    }

    if (result.routes!.length > 0 || hasCreateRouter) {
      result.frameworkRole = 'router_config';
    } else if (hasOutlet) {
      result.frameworkRole = 'router_layout';
    } else if (result.edges!.length > 0) {
      result.frameworkRole = 'router_consumer';
    } else if (hasImport) {
      result.frameworkRole = 'router_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
