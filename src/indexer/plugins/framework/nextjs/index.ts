/**
 * NextJSPlugin — detects Next.js projects and extracts file-based routes
 * for both App Router and Pages Router, including parallel routes,
 * intercepting routes, data fetching functions, and template/default files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../plugin-api/types.js';

const PAGE_EXTENSIONS = /\.(tsx|ts|jsx|js)$/;
const APP_ROUTER_FILES = ['page', 'layout', 'loading', 'error', 'not-found', 'route', 'template', 'default'] as const;
const API_ROUTE_EXPORTS_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;
const USE_SERVER_RE = /['"]use server['"]/;
const DATA_FETCHING_RE = /export\s+async\s+function\s+(getStaticProps|getServerSideProps|getStaticPaths)\b/g;

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
    const catchAll = seg.match(/^\[\.\.\.(\w+)\]$/);
    if (catchAll) return `:${catchAll[1]}*`;

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
        { name: 'next_renders_page', category: 'nextjs', description: 'Layout renders page' },
        { name: 'next_server_action', category: 'nextjs', description: 'Server action reference' },
        { name: 'next_middleware', category: 'nextjs', description: 'Middleware applies to routes' },
        { name: 'next_parallel_slot', category: 'nextjs', description: 'Parallel route slot' },
        { name: 'next_intercepting', category: 'nextjs', description: 'Intercepting route' },
        { name: 'next_data_fetching', category: 'nextjs', description: 'Pages Router data fetching function' },
        { name: 'next_template', category: 'nextjs', description: 'Template component for route segment' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    // App Router
    if (filePath.startsWith('app/')) {
      const fileType = getAppRouterFileType(filePath);
      const parallelSlot = extractParallelSlot(filePath);
      const interceptingInfo = extractInterceptingInfo(filePath);

      if (fileType === 'page') {
        const uri = appRouterPathToRoute(filePath);
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
        const uri = appRouterPathToRoute(filePath);
        for (const method of methods) {
          result.routes!.push({ method, uri });
        }
        result.frameworkRole = 'next_api_route';
      }
    }

    // Pages Router
    if (filePath.startsWith('pages/') && PAGE_EXTENSIONS.test(filePath)) {
      const uri = pagesRouterPathToRoute(filePath);
      if (filePath.startsWith('pages/api/')) {
        result.routes!.push({ method: 'ALL', uri });
        result.frameworkRole = 'next_api_page';
      } else {
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
    }

    // Detect server actions
    if (USE_SERVER_RE.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'next_server_action';
    }

    // Detect middleware
    if (filePath === 'middleware.ts' || filePath === 'middleware.js') {
      result.frameworkRole = 'next_middleware';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    // Find layout files and their nested pages
    const layouts = allFiles.filter((f) => {
      const basename = path.basename(f.path).replace(PAGE_EXTENSIONS, '');
      return f.path.startsWith('app/') && basename === 'layout';
    });

    const pages = allFiles.filter((f) => {
      const basename = path.basename(f.path).replace(PAGE_EXTENSIONS, '');
      return f.path.startsWith('app/') && basename === 'page';
    });

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
    }

    // Parallel route slot edges
    const parallelPages = allFiles.filter((f) => {
      return f.path.startsWith('app/') && extractParallelSlot(f.path) !== null;
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
      if (!f.path.startsWith('app/')) return false;
      return extractInterceptingInfo(f.path) !== null;
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
      const basename = path.basename(f.path).replace(PAGE_EXTENSIONS, '');
      return f.path.startsWith('app/') && basename === 'template';
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
    const pagesRouterFiles = allFiles.filter((f) =>
      f.path.startsWith('pages/') &&
      !f.path.startsWith('pages/api/') &&
      PAGE_EXTENSIONS.test(f.path),
    );

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
    return methods.length > 0 ? methods : ['GET'];
  }
}
