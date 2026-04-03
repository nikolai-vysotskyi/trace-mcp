/**
 * NextJSPlugin — detects Next.js projects and extracts file-based routes
 * for both App Router and Pages Router.
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
  RawRoute,
  ResolveContext,
} from '../../../../plugin-api/types.js';

const PAGE_EXTENSIONS = /\.(tsx|ts|jsx|js)$/;
const APP_ROUTER_FILES = ['page', 'layout', 'loading', 'error', 'not-found', 'route'] as const;
const API_ROUTE_EXPORTS_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;
const USE_SERVER_RE = /['"]use server['"]/;

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
    .filter((seg) => !seg.startsWith('(')) // strip route groups
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
      if (fileType === 'page') {
        const uri = appRouterPathToRoute(filePath);
        result.routes!.push({ method: 'GET', uri });
        result.frameworkRole = 'next_page';
      } else if (fileType === 'layout') {
        result.frameworkRole = 'next_layout';
      } else if (fileType === 'loading') {
        result.frameworkRole = 'next_loading';
      } else if (fileType === 'error') {
        result.frameworkRole = 'next_error';
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
