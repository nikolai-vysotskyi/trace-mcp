/**
 * NextJSPlugin — detects Next.js projects and extracts file-based routes
 * for both App Router and Pages Router, including parallel routes,
 * intercepting routes, data fetching functions, and template/default files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

const PAGE_EXTENSIONS = /\.(tsx|ts|jsx|js)$/;
const APP_ROUTER_FILES = ['page', 'layout', 'loading', 'error', 'not-found', 'route', 'template', 'default', 'forbidden', 'unauthorized', 'global-error', 'global-not-found'] as const;

// Metadata file conventions — automatically served by Next.js, not imported by user code
const METADATA_FILES = ['sitemap', 'robots', 'opengraph-image', 'twitter-image', 'icon', 'apple-icon', 'manifest'] as const;
const API_ROUTE_EXPORTS_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;
const USE_SERVER_RE = /['"]use server['"]/;
const USE_CLIENT_RE = /['"]use client['"]/;
const USE_CACHE_RE = /['"]use cache(?::\s*(remote|private))?['"]/;
const DATA_FETCHING_RE = /export\s+async\s+function\s+(getStaticProps|getServerSideProps|getStaticPaths)\b/g;

// App Router export conventions
const GENERATE_STATIC_PARAMS_RE = /export\s+(?:async\s+)?function\s+generateStaticParams\b/;
const GENERATE_METADATA_RE = /export\s+(?:async\s+)?function\s+generateMetadata\b/;
const STATIC_METADATA_RE = /export\s+const\s+metadata\b/;
const GENERATE_VIEWPORT_RE = /export\s+(?:async\s+)?function\s+generateViewport\b/;
const STATIC_VIEWPORT_RE = /export\s+const\s+viewport\b/;
const GENERATE_SITEMAPS_RE = /export\s+(?:async\s+)?function\s+generateSitemaps\b/;
const GENERATE_IMAGE_METADATA_RE = /export\s+(?:async\s+)?function\s+generateImageMetadata\b/;

// Route Segment Config exports
const ROUTE_SEGMENT_CONFIG_RE = /export\s+const\s+(dynamic|dynamicParams|revalidate|fetchCache|runtime|preferredRegion|maxDuration)\s*=\s*([^\n;]+)/g;

// Pages Router legacy
const GET_INITIAL_PROPS_RE = /\.getInitialProps\s*=/;

// Middleware/Proxy config matcher
const CONFIG_MATCHER_RE = /export\s+const\s+config\s*=\s*\{[^}]*matcher\s*:\s*(\[[^\]]*\]|['"][^'"]*['"])/s;

// Pages Router special files that are NOT regular pages
const PAGES_SPECIAL_FILES: Record<string, string> = {
  '_app': 'next_custom_app',
  '_document': 'next_custom_document',
  '_error': 'next_custom_error',
  '404': 'next_404_page',
  '500': 'next_500_page',
};

/**
 * Classify a file as a Next.js entry point that is auto-loaded by the framework
 * (not imported by user code). Returns the entry-point type or null.
 */
export function classifyNextEntryPoint(filePath: string): string | null {
  const np = normalizeSrcPath(filePath);
  const basename = path.basename(np).replace(PAGE_EXTENSIONS, '');

  // App Router files (must live under app/)
  if (np.startsWith('app/')) {
    if ((APP_ROUTER_FILES as readonly string[]).includes(basename)) {
      return basename; // 'page' | 'layout' | 'loading' | 'error' | 'route' | ...
    }
    // Metadata file conventions (sitemap.js, robots.js, opengraph-image.js, etc.)
    if ((METADATA_FILES as readonly string[]).includes(basename)) {
      return `metadata:${basename}`;
    }
    // Numbered metadata files like sitemap-0.ts, opengraph-image-1.tsx
    for (const mf of METADATA_FILES) {
      if (new RegExp(`^${mf}-\\d+$`).test(basename)) return `metadata:${mf}`;
    }
  }

  // Pages Router files (must live under pages/)
  if (np.startsWith('pages/')) {
    // _app, _document, _error, 404, 500
    if (basename in PAGES_SPECIAL_FILES) {
      return PAGES_SPECIAL_FILES[basename];
    }
    // Any regular page file
    if (PAGE_EXTENSIONS.test(path.basename(np))) {
      return 'page';
    }
  }

  // Root-level framework files
  if (basename === 'middleware' && np.split('/').length <= 2) return 'middleware';
  if (basename === 'instrumentation' && np.split('/').length <= 2) return 'instrumentation';
  if (basename === 'instrumentation-client' && np.split('/').length <= 2) return 'instrumentation-client';
  if (basename === 'mdx-components' && np.split('/').length <= 2) return 'mdx-components';

  return null;
}


/**
 * Convert an App Router file path to a route URI.
 * app/page.tsx -> /
 * app/users/page.tsx -> /users
 * app/users/[id]/page.tsx -> /users/:id
 * app/blog/[...slug]/page.tsx -> /blog/:slug*
 * app/(group)/page.tsx -> / (route groups stripped)
 */
export function appRouterPathToRoute(filePath: string): string {
  // Remove app/ prefix and file name
  let route = filePath.replace(/^app\//, '');
  // Remove the filename part (page.tsx, layout.tsx, etc.)
  const parts = route.split('/');
  parts.pop(); // remove filename
  route = parts.join('/');

  if (!route) return '/';

  const segments = route.split('/').filter(Boolean);
  const routeSegments = segments
    .filter((seg) => !seg.startsWith('(')) // strip route groups and intercepting prefixes
    .filter((seg) => !seg.startsWith('@')) // strip parallel route slots
    .map((seg) => {
      // Catch-all: [...slug] -> :slug*
      const catchAll = seg.match(/^\[\.\.\.(\w+)\]$/);
      if (catchAll) return `:${catchAll[1]}*`;

      // Optional catch-all: [[...slug]] -> :slug*
      const optCatchAll = seg.match(/^\[\[\.\.\.(\w+)\]\]$/);
      if (optCatchAll) return `:${optCatchAll[1]}*`;

      // Dynamic: [id] -> :id
      const dynamic = seg.match(/^\[(\w+)\]$/);
      if (dynamic) return `:${dynamic[1]}`;

      return seg;
    });

  return '/' + routeSegments.join('/');
}

/**
 * Convert a Pages Router file path to a route URI.
 * pages/index.tsx -> /
 * pages/users/[id].tsx -> /users/:id
 * pages/api/users.ts -> /api/users
 */
export function pagesRouterPathToRoute(filePath: string): string {
  let route = filePath
    .replace(/^pages\//, '')
    .replace(PAGE_EXTENSIONS, '');

  // Handle index
  route = route.replace(/\/index$/, '');
  if (route === 'index') route = '';

  const segments = route.split('/').filter(Boolean);
  const routeSegments = segments.map((seg) => {
    // Optional catch-all: [[...slug]] -> :slug*
    const optCatchAll = seg.match(/^\[\[\.\.\.(\w+)\]\]$/);
    if (optCatchAll) return `:${optCatchAll[1]}*`;

    // Catch-all: [...slug] -> :slug*
    const catchAll = seg.match(/^\[\.\.\.(\w+)\]$/);
    if (catchAll) return `:${catchAll[1]}*`;

    // Dynamic: [id] -> :id
    const dynamic = seg.match(/^\[(\w+)\]$/);
    if (dynamic) return `:${dynamic[1]}`;

    return seg;
  });

  return '/' + routeSegments.join('/');
}

/** Determine the file type from an App Router path. */
function getAppRouterFileType(filePath: string): string | null {
  const basename = path.basename(filePath).replace(PAGE_EXTENSIONS, '');
  if (APP_ROUTER_FILES.includes(basename as (typeof APP_ROUTER_FILES)[number])) {
    return basename;
  }
  return null;
}

/** Extract parallel route slot name from file path (e.g. @analytics). */
function extractParallelSlot(filePath: string): string | null {
  const segments = filePath.split('/');
  for (const seg of segments) {
    if (seg.startsWith('@')) {
      return seg.slice(1); // remove @ prefix
    }
  }
  return null;
}

/**
 * Extract intercepting route info from file path.
 * Returns the intercept pattern and the intercepted route, or null.
 * e.g. app/feed/(..photos)/[id]/page.tsx -> { pattern: '..', interceptedRoute: '/photos/:id' }
 */
function extractInterceptingInfo(filePath: string): { pattern: string; interceptedRoute: string } | null {
  const segments = filePath.replace(/^app\//, '').split('/');
  segments.pop(); // remove filename

  for (let i = 0; i < segments.length; i++) {
    // Handle (..)(..)segment — two levels up (Next.js convention for 2-level intercept)
    const twoLevelMatch = segments[i].match(/^\(\.{2}\)\(\.{2}\)(.+)$/);
    if (twoLevelMatch) {
      const routeName = twoLevelMatch[1];
      const remaining = [routeName, ...segments.slice(i + 1)];
      const routeSegments = remaining.map((seg) => {
        const catchAll = seg.match(/^\[\.\.\.(\w+)\]$/);
        if (catchAll) return `:${catchAll[1]}*`;
        const dynamic = seg.match(/^\[(\w+)\]$/);
        if (dynamic) return `:${dynamic[1]}`;
        return seg;
      });
      return {
        pattern: '(..)(..)',
        interceptedRoute: '/' + routeSegments.join('/'),
      };
    }

    // Matches both formats: (.)detail, (..)photos, (...)photos  AND  (.detail), (..photos), (...photos)
    const match = segments[i].match(/^\((\.{1,3})\)(.+)$/) || segments[i].match(/^\((\.{1,3})([^)]+)\)$/);
    if (match) {
      const pattern = match[1]; // '.', '..', or '...'
      const routeName = match[2]; // e.g. 'photos'

      // Build the intercepted route from the remaining segments after the intercepting one
      const remaining = [routeName, ...segments.slice(i + 1)];
      const routeSegments = remaining.map((seg) => {
        const catchAll = seg.match(/^\[\.\.\.(\w+)\]$/);
        if (catchAll) return `:${catchAll[1]}*`;
        const dynamic = seg.match(/^\[(\w+)\]$/);
        if (dynamic) return `:${dynamic[1]}`;
        return seg;
      });

      return {
        pattern,
        interceptedRoute: '/' + routeSegments.join('/'),
      };
    }
  }
  return null;
}

/**
 * Normalize Next.js paths so downstream checks can do `np.startsWith('app/')`
 * regardless of the project layout:
 *   - `app/...`                    → `app/...`
 *   - `src/app/...`                → `app/...`
 *   - `frontend/src/app/...`       → `app/...` (nested workspace)
 *   - `frontend/app/...`           → `app/...`
 *   - `src/middleware.ts`          → `middleware.ts`
 *   - `frontend/middleware.ts`     → `middleware.ts` (nested workspace root)
 */
function normalizeSrcPath(filePath: string): string {
  // Case A: path contains app/ or pages/ — trim everything before it
  const structured = filePath.match(/^(.*?)(?:(?:^|\/)(?:src\/)?(app|pages)\/)(.*)$/);
  if (structured) {
    return `${structured[2]}/${structured[3]}`;
  }
  // Case B: root-level file like `middleware.ts` or `src/middleware.ts` or
  // `frontend/middleware.ts` — take just the basename's directory relative prefix.
  const parts = filePath.split('/');
  const basename = parts[parts.length - 1];
  const ROOT_FILES = new Set([
    'middleware', 'proxy', 'instrumentation', 'instrumentation-client',
    'mdx-components', 'next.config', 'next-env',
  ]);
  const stem = basename.replace(PAGE_EXTENSIONS, '');
  if (ROOT_FILES.has(stem)) return basename;
  return filePath;
}

/** Extract Pages Router data fetching function names from source. */
function extractDataFetchingFunctions(source: string): string[] {
  const fns: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(DATA_FETCHING_RE.source, 'g');
  while ((match = re.exec(source)) !== null) {
    fns.push(match[1]);
  }
  return fns;
}

export class NextJSPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'nextjs',
    version: '1.0.0',
    priority: 15,
    category: 'framework',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('next' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return 'next' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'next_entry_point', category: 'nextjs', description: 'Next.js file-based auto-loaded entry point (page, layout, route, loading, error, metadata files, etc.)' },
        { name: 'next_renders_page', category: 'nextjs', description: 'Layout renders page' },
        { name: 'next_renders_loading', category: 'nextjs', description: 'Layout renders loading boundary' },
        { name: 'next_renders_error', category: 'nextjs', description: 'Layout renders error boundary' },
        { name: 'next_renders_not_found', category: 'nextjs', description: 'Layout renders not-found boundary' },
        { name: 'next_server_action', category: 'nextjs', description: 'Server action reference' },
        { name: 'next_middleware', category: 'nextjs', description: 'Middleware applies to routes' },
        { name: 'next_parallel_slot', category: 'nextjs', description: 'Parallel route slot' },
        { name: 'next_intercepting', category: 'nextjs', description: 'Intercepting route' },
        { name: 'next_data_fetching', category: 'nextjs', description: 'Pages Router data fetching function' },
        { name: 'next_template', category: 'nextjs', description: 'Template component for route segment' },
        { name: 'next_forbidden', category: 'nextjs', description: 'Forbidden (403) error page' },
        { name: 'next_unauthorized', category: 'nextjs', description: 'Unauthorized (401) error page' },
        { name: 'next_global_error', category: 'nextjs', description: 'Global error boundary' },
        { name: 'next_global_not_found', category: 'nextjs', description: 'Global not-found page (v15.2+)' },
        { name: 'next_metadata', category: 'nextjs', description: 'Metadata file convention (sitemap, robots, opengraph-image, etc.)' },
        { name: 'next_instrumentation', category: 'nextjs', description: 'Instrumentation hook (register, onRequestError)' },
        { name: 'next_instrumentation_client', category: 'nextjs', description: 'Client instrumentation hook (v15+)' },
        { name: 'next_mdx_components', category: 'nextjs', description: 'MDX component overrides' },
        { name: 'next_config', category: 'nextjs', description: 'Next.js project configuration' },
        { name: 'next_custom_app', category: 'nextjs', description: 'Pages Router custom _app' },
        { name: 'next_custom_document', category: 'nextjs', description: 'Pages Router custom _document' },
        { name: 'next_custom_error', category: 'nextjs', description: 'Pages Router custom _error' },
        { name: 'next_404_page', category: 'nextjs', description: 'Pages Router custom 404 page' },
        { name: 'next_500_page', category: 'nextjs', description: 'Pages Router custom 500 page' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    // Static metadata files in app/ directory (non-code: .ico, .png, .jpg, .xml, .txt, .webmanifest)
    const normalizedPath = normalizeSrcPath(filePath);
    if (normalizedPath.startsWith('app/')) {
      const staticMetaMatch = path.basename(normalizedPath).match(
        /^(favicon\.ico|icon\.(ico|png|jpg|jpeg|svg)|apple-icon\.(png|jpg|jpeg)|opengraph-image\.(png|jpg|jpeg|gif)|twitter-image\.(png|jpg|jpeg|gif)|sitemap\.xml|robots\.txt|manifest\.(json|webmanifest))$/,
      );
      if (staticMetaMatch) {
        return ok({
          status: 'ok',
          symbols: [],
          frameworkRole: 'next_static_metadata',
          metadata: { staticMetadataFile: staticMetaMatch[0] },
        });
      }
    }

    if (!['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    // App Router
    if (normalizedPath.startsWith('app/')) {
      const fileType = getAppRouterFileType(normalizedPath);
      const parallelSlot = extractParallelSlot(normalizedPath);
      const interceptingInfo = extractInterceptingInfo(normalizedPath);

      if (fileType === 'page') {
        const uri = appRouterPathToRoute(normalizedPath);
        result.routes!.push({ method: 'GET', uri });
        result.frameworkRole = 'next_page';

        // Parallel route slot metadata
        if (parallelSlot) {
          result.metadata = {
            ...result.metadata,
            parallelSlot,
          };
        }

        // Intercepting route metadata
        if (interceptingInfo) {
          result.metadata = {
            ...result.metadata,
            intercepting: true,
            interceptPattern: interceptingInfo.pattern,
            interceptedRoute: interceptingInfo.interceptedRoute,
          };
        }
      } else if (fileType === 'layout') {
        result.frameworkRole = 'next_layout';
      } else if (fileType === 'loading') {
        result.frameworkRole = 'next_loading';
      } else if (fileType === 'error') {
        result.frameworkRole = 'next_error';
      } else if (fileType === 'template') {
        result.frameworkRole = 'next_template';
      } else if (fileType === 'default') {
        result.frameworkRole = 'next_default';
        if (parallelSlot) {
          result.metadata = {
            ...result.metadata,
            parallelSlot,
          };
        }
      } else if (fileType === 'route') {
        // API route handler — extract exported HTTP methods
        const methods = this.extractApiMethods(source);
        const uri = appRouterPathToRoute(normalizedPath);
        for (const method of methods) {
          result.routes!.push({ method, uri });
        }
        result.frameworkRole = 'next_api_route';
      } else if (fileType === 'forbidden') {
        result.frameworkRole = 'next_forbidden';
      } else if (fileType === 'unauthorized') {
        result.frameworkRole = 'next_unauthorized';
      } else if (fileType === 'global-error') {
        result.frameworkRole = 'next_global_error';
      } else if (fileType === 'global-not-found') {
        result.frameworkRole = 'next_global_not_found';
      }

      // Metadata file conventions (sitemap.js, robots.js, opengraph-image.js, etc.)
      if (!result.frameworkRole) {
        const metaBasename = path.basename(normalizedPath).replace(PAGE_EXTENSIONS, '');
        if (METADATA_FILES.includes(metaBasename as (typeof METADATA_FILES)[number])) {
          result.frameworkRole = 'next_metadata';
        }
      }
    }

    // Pages Router
    if (normalizedPath.startsWith('pages/') && PAGE_EXTENSIONS.test(normalizedPath)) {
      // Check for Pages Router special files (_app, _document, _error, 404, 500)
      const pagesBasename = path.basename(normalizedPath).replace(PAGE_EXTENSIONS, '');
      const pagesDir = path.dirname(normalizedPath);
      const isTopLevelPage = pagesDir === 'pages';
      const specialRole = isTopLevelPage ? PAGES_SPECIAL_FILES[pagesBasename] : undefined;

      if (specialRole) {
        result.frameworkRole = specialRole;
        // _app and _document don't have routes; 404/500/_error are error pages
      } else if (normalizedPath.startsWith('pages/api/')) {
        const uri = pagesRouterPathToRoute(normalizedPath);
        result.routes!.push({ method: 'ALL', uri });
        result.frameworkRole = 'next_api_page';
      } else {
        const uri = pagesRouterPathToRoute(normalizedPath);
        result.routes!.push({ method: 'GET', uri });
        result.frameworkRole = 'next_page';

        // Detect data fetching functions
        const dataFns = extractDataFetchingFunctions(source);
        if (dataFns.length > 0) {
          result.metadata = {
            ...result.metadata,
            dataFetching: dataFns,
          };
        }
      }

      // Detect getInitialProps (legacy pattern)
      if (GET_INITIAL_PROPS_RE.test(source)) {
        result.metadata = {
          ...result.metadata,
          dataFetching: [...((result.metadata?.dataFetching as string[]) ?? []), 'getInitialProps'],
        };
      }
    }

    // --- Directives ---

    // Detect 'use server' (server actions) — file-level vs inline
    if (USE_SERVER_RE.test(source)) {
      // File-level: directive appears at the very top (possibly after comments/whitespace)
      const trimmed = source.replace(/^(\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*\n|\s*\n)*/m, '');
      const isFileLevel = /^['"]use server['"]/.test(trimmed);
      result.frameworkRole = result.frameworkRole ?? 'next_server_action';
      result.metadata = {
        ...result.metadata,
        directive: 'use server',
        serverActionScope: isFileLevel ? 'file' : 'inline',
      };
    }

    // Detect 'use client' (client component boundary)
    if (USE_CLIENT_RE.test(source)) {
      result.metadata = { ...result.metadata, directive: 'use client', clientComponent: true };
    }

    // Detect 'use cache' (v16 caching directive)
    const cacheMatch = source.match(USE_CACHE_RE);
    if (cacheMatch) {
      result.metadata = {
        ...result.metadata,
        directive: cacheMatch[1] ? `use cache: ${cacheMatch[1]}` : 'use cache',
        cacheType: cacheMatch[1] ?? 'default',
      };
    }

    // --- Root-level conventions ---

    // middleware.js → proxy.js (Next.js 16 rename)
    if (normalizedPath === 'middleware.ts' || normalizedPath === 'middleware.js' ||
        normalizedPath === 'proxy.ts' || normalizedPath === 'proxy.js') {
      result.frameworkRole = 'next_middleware';

      // Extract config.matcher if present
      const matcherMatch = source.match(CONFIG_MATCHER_RE);
      if (matcherMatch) {
        result.metadata = { ...result.metadata, matcher: matcherMatch[1] };
      }
    }

    // instrumentation.js — Next.js instrumentation hook (register/onRequestError)
    if (normalizedPath === 'instrumentation.ts' || normalizedPath === 'instrumentation.js') {
      result.frameworkRole = 'next_instrumentation';
    }

    // instrumentation-client.js — client-side instrumentation (v15+)
    if (normalizedPath === 'instrumentation-client.ts' || normalizedPath === 'instrumentation-client.js') {
      result.frameworkRole = 'next_instrumentation_client';
    }

    // mdx-components.tsx — MDX component overrides (v13+)
    if (normalizedPath === 'mdx-components.tsx' || normalizedPath === 'mdx-components.ts' ||
        normalizedPath === 'mdx-components.jsx' || normalizedPath === 'mdx-components.js') {
      result.frameworkRole = 'next_mdx_components';
    }

    // next.config.js/mjs/ts — project configuration
    if (/^next\.config\.(js|mjs|ts)$/.test(normalizedPath)) {
      result.frameworkRole = 'next_config';
    }

    // --- App Router export conventions ---
    if (normalizedPath.startsWith('app/') || result.frameworkRole?.startsWith('next_')) {
      // generateStaticParams
      if (GENERATE_STATIC_PARAMS_RE.test(source)) {
        result.metadata = {
          ...result.metadata,
          dataFetching: [...((result.metadata?.dataFetching as string[]) ?? []), 'generateStaticParams'],
        };
      }

      // Metadata: generateMetadata / export const metadata
      if (GENERATE_METADATA_RE.test(source)) {
        result.metadata = { ...result.metadata, hasMetadata: true, metadataType: 'dynamic' };
      } else if (STATIC_METADATA_RE.test(source)) {
        result.metadata = { ...result.metadata, hasMetadata: true, metadataType: 'static' };
      }

      // Viewport: generateViewport / export const viewport (v14+)
      if (GENERATE_VIEWPORT_RE.test(source)) {
        result.metadata = { ...result.metadata, hasViewport: true, viewportType: 'dynamic' };
      } else if (STATIC_VIEWPORT_RE.test(source)) {
        result.metadata = { ...result.metadata, hasViewport: true, viewportType: 'static' };
      }

      // generateSitemaps / generateImageMetadata
      if (GENERATE_SITEMAPS_RE.test(source)) {
        result.metadata = { ...result.metadata, generatesSitemaps: true };
      }
      if (GENERATE_IMAGE_METADATA_RE.test(source)) {
        result.metadata = { ...result.metadata, generatesImageMetadata: true };
      }

      // Route Segment Config exports (dynamic, revalidate, runtime, etc.)
      const segmentConfig: Record<string, string> = {};
      const configRe = new RegExp(ROUTE_SEGMENT_CONFIG_RE.source, 'g');
      let configMatch: RegExpExecArray | null;
      while ((configMatch = configRe.exec(source)) !== null) {
        segmentConfig[configMatch[1]] = configMatch[2].trim().replace(/['"]/g, '');
      }
      if (Object.keys(segmentConfig).length > 0) {
        result.metadata = { ...result.metadata, routeSegmentConfig: segmentConfig };
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    // Mark Next.js file-based auto-loaded entry points (App Router + Pages Router
    // + metadata files + middleware). These are never imported by user code —
    // the Next.js runtime loads them by convention. Without this edge they look
    // disconnected in the graph.
    for (const file of allFiles) {
      const entryType = classifyNextEntryPoint(file.path);
      if (!entryType) continue;
      const symbols = ctx.getSymbolsByFile(file.id);
      for (const sym of symbols) {
        if (sym.kind !== 'function' && sym.kind !== 'class') continue;
        // Skip synthetic __module__ pseudo-symbols — they're not real entry points
        if (sym.name.startsWith('__module__')) continue;
        edges.push({
          sourceNodeType: 'file',
          sourceRefId: file.id,
          targetSymbolId: sym.symbolId,
          edgeType: 'next_entry_point',
          metadata: { entryType },
        });
      }
    }

    // Find layout files and their nested pages (supports both app/ and src/app/)
    const layouts = allFiles.filter((f) => {
      const np = normalizeSrcPath(f.path);
      const basename = path.basename(np).replace(PAGE_EXTENSIONS, '');
      return np.startsWith('app/') && basename === 'layout';
    });

    const pages = allFiles.filter((f) => {
      const np = normalizeSrcPath(f.path);
      const basename = path.basename(np).replace(PAGE_EXTENSIONS, '');
      return np.startsWith('app/') && basename === 'page';
    });

    // Collect loading, error, not-found files for layout → boundary edges
    const boundaryTypes: { basename: string; edgeType: string }[] = [
      { basename: 'loading', edgeType: 'next_renders_loading' },
      { basename: 'error', edgeType: 'next_renders_error' },
      { basename: 'not-found', edgeType: 'next_renders_not_found' },
    ];

    const boundaryFiles = new Map<string, typeof allFiles>();
    for (const bt of boundaryTypes) {
      boundaryFiles.set(bt.basename, allFiles.filter((f) => {
        const np = normalizeSrcPath(f.path);
        const bn = path.basename(np).replace(PAGE_EXTENSIONS, '');
        return np.startsWith('app/') && bn === bt.basename;
      }));
    }

    for (const layout of layouts) {
      const layoutDir = path.dirname(layout.path);
      const layoutSymbols = ctx.getSymbolsByFile(layout.id);
      const layoutSym = layoutSymbols.find((s) => s.kind === 'function' || s.kind === 'class');
      if (!layoutSym) continue;

      // Find pages nested under this layout
      for (const page of pages) {
        if (page.path.startsWith(layoutDir + '/') || layoutDir === 'app') {
          const pageSymbols = ctx.getSymbolsByFile(page.id);
          const pageSym = pageSymbols.find((s) => s.kind === 'function' || s.kind === 'class');
          if (!pageSym) continue;

          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: layoutSym.id,
            targetNodeType: 'symbol',
            targetRefId: pageSym.id,
            edgeType: 'next_renders_page',
          });
        }
      }

      // Layout → loading/error/not-found boundary edges
      for (const bt of boundaryTypes) {
        const files = boundaryFiles.get(bt.basename) ?? [];
        for (const file of files) {
          if (path.dirname(file.path) === layoutDir ||
              (file.path.startsWith(layoutDir + '/') && layoutDir === 'app')) {
            const fileSymbols = ctx.getSymbolsByFile(file.id);
            const fileSym = fileSymbols.find((s) => s.kind === 'function' || s.kind === 'class');
            if (!fileSym) continue;

            edges.push({
              sourceNodeType: 'symbol',
              sourceRefId: layoutSym.id,
              targetNodeType: 'symbol',
              targetRefId: fileSym.id,
              edgeType: bt.edgeType,
            });
          }
        }
      }
    }

    // Parallel route slot edges
    const parallelPages = allFiles.filter((f) => {
      const np = normalizeSrcPath(f.path);
      return np.startsWith('app/') && extractParallelSlot(np) !== null;
    });

    for (const file of parallelPages) {
      const slot = extractParallelSlot(file.path);
      if (!slot) continue;

      // Find the parent layout
      const segments = file.path.split('/');
      const slotIdx = segments.findIndex((s) => s.startsWith('@'));
      if (slotIdx < 1) continue;

      const parentDir = segments.slice(0, slotIdx).join('/');
      const parentLayout = allFiles.find((f) =>
        f.path.startsWith(parentDir + '/') &&
        !f.path.includes('@') &&
        /layout\.(tsx|ts|jsx|js)$/.test(path.basename(f.path)),
      );

      if (parentLayout) {
        const layoutSymbols = ctx.getSymbolsByFile(parentLayout.id);
        const layoutSym = layoutSymbols.find((s) => s.kind === 'function' || s.kind === 'class');
        const fileSymbols = ctx.getSymbolsByFile(file.id);
        const fileSym = fileSymbols.find((s) => s.kind === 'function' || s.kind === 'class');

        if (layoutSym && fileSym) {
          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: layoutSym.id,
            targetNodeType: 'symbol',
            targetRefId: fileSym.id,
            edgeType: 'next_parallel_slot',
            metadata: { slot },
          });
        }
      }
    }

    // Intercepting route edges
    const interceptingFiles = allFiles.filter((f) => {
      const np = normalizeSrcPath(f.path);
      if (!np.startsWith('app/')) return false;
      return extractInterceptingInfo(np) !== null;
    });

    for (const file of interceptingFiles) {
      const info = extractInterceptingInfo(file.path);
      if (!info) continue;

      const fileSymbols = ctx.getSymbolsByFile(file.id);
      const fileSym = fileSymbols.find((s) => s.kind === 'function' || s.kind === 'class');
      if (!fileSym) continue;

      // Find the target page that matches the intercepted route
      const targetPage = pages.find((p) => {
        const pageRoute = appRouterPathToRoute(p.path);
        return pageRoute === info.interceptedRoute;
      });

      if (targetPage) {
        const targetSymbols = ctx.getSymbolsByFile(targetPage.id);
        const targetSym = targetSymbols.find((s) => s.kind === 'function' || s.kind === 'class');
        if (targetSym) {
          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: fileSym.id,
            targetNodeType: 'symbol',
            targetRefId: targetSym.id,
            edgeType: 'next_intercepting',
            metadata: {
              pattern: info.pattern,
              interceptedRoute: info.interceptedRoute,
            },
          });
        }
      }
    }

    // Template edges
    const templates = allFiles.filter((f) => {
      const np = normalizeSrcPath(f.path);
      const basename = path.basename(np).replace(PAGE_EXTENSIONS, '');
      return np.startsWith('app/') && basename === 'template';
    });

    for (const template of templates) {
      const templateDir = path.dirname(template.path);
      const templateSymbols = ctx.getSymbolsByFile(template.id);
      const templateSym = templateSymbols.find((s) => s.kind === 'function' || s.kind === 'class');
      if (!templateSym) continue;

      // Find pages nested under this template
      for (const page of pages) {
        if (page.path.startsWith(templateDir + '/') || templateDir === 'app') {
          const pageSymbols = ctx.getSymbolsByFile(page.id);
          const pageSym = pageSymbols.find((s) => s.kind === 'function' || s.kind === 'class');
          if (!pageSym) continue;

          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: templateSym.id,
            targetNodeType: 'symbol',
            targetRefId: pageSym.id,
            edgeType: 'next_template',
          });
        }
      }
    }

    // Pages Router data fetching edges
    const pagesRouterFiles = allFiles.filter((f) => {
      const np = normalizeSrcPath(f.path);
      return np.startsWith('pages/') &&
        !np.startsWith('pages/api/') &&
        PAGE_EXTENSIONS.test(np);
    });

    for (const file of pagesRouterFiles) {
      let source: string;
      try {
        source = fs.readFileSync(path.resolve(ctx.rootPath, file.path), 'utf-8');
      } catch { continue; }

      const dataFns = extractDataFetchingFunctions(source);
      if (dataFns.length === 0) continue;

      const fileSymbols = ctx.getSymbolsByFile(file.id);
      const pageSym = fileSymbols.find((s) => s.kind === 'function' || s.kind === 'class');
      if (!pageSym) continue;

      for (const fnName of dataFns) {
        const fnSym = fileSymbols.find((s) => s.kind === 'function' && s.name === fnName);
        if (fnSym) {
          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: pageSym.id,
            targetNodeType: 'symbol',
            targetRefId: fnSym.id,
            edgeType: 'next_data_fetching',
            metadata: { function: fnName },
          });
        }
      }
    }

    return ok(edges);
  }

  private extractApiMethods(source: string): string[] {
    const methods: string[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(API_ROUTE_EXPORTS_RE.source, 'g');
    while ((match = re.exec(source)) !== null) {
      methods.push(match[1]);
    }
    return methods;
  }
}
