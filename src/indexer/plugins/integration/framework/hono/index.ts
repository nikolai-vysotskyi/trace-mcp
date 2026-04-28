/**
 * HonoPlugin — detects Hono projects and extracts route handlers,
 * middleware usage, and route groups.
 *
 * Hono is a modern, ultrafast web framework for the Edge
 * (Cloudflare Workers, Deno, Bun, Node.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// app.get('/path', handler), app.post(...), etc.
const ROUTE_RE =
  /(?:app|router|hono)\s*\.\s*(get|post|put|delete|patch|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// app.on('GET', '/path', handler) or app.on('POST', '/path', handler)
const ON_RE = /(?:app|router|hono)\s*\.\s*on\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g;

// app.route('/api', subApp)
const ROUTE_GROUP_RE =
  /(?:app|router|hono)\s*\.\s*route\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z][\w]*)/g;

// app.use('/path', middleware) — path-scoped
const MIDDLEWARE_PATH_RE =
  /(?:app|router|hono)\s*\.\s*use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z][\w.]*(?:\s*\(\s*[^)]*\))?)/g;

// app.use(middleware()) — global (no path string as first arg)
const MIDDLEWARE_GLOBAL_RE =
  /(?:app|router|hono)\s*\.\s*use\s*\(\s*([A-Za-z][\w.]*(?:\s*\(\s*[^)]*\))?)\s*[,)]/g;

// app.basePath('/v1')
const _BASEPATH_RE = /(?:app|router|hono)\s*\.\s*basePath\s*\(\s*['"`]([^'"`]+)['"`]/g;

interface HonoRoute {
  method: string;
  path: string;
}

interface HonoMiddleware {
  path: string | null;
  name: string;
}

/** Extract route definitions from Hono source code. */
export function extractHonoRoutes(source: string): HonoRoute[] {
  const routes: HonoRoute[] = [];

  // Shorthand: app.get('/path', handler)
  const shortRe = new RegExp(ROUTE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = shortRe.exec(source)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
    });
  }

  // app.on('METHOD', '/path', handler)
  const onRe = new RegExp(ON_RE.source, 'g');
  while ((match = onRe.exec(source)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
    });
  }

  // app.route('/prefix', subApp) — mount as route group
  const groupRe = new RegExp(ROUTE_GROUP_RE.source, 'g');
  while ((match = groupRe.exec(source)) !== null) {
    routes.push({
      method: 'USE',
      path: match[1],
    });
  }

  return routes;
}

/** Extract middleware use() calls from Hono source code. */
export function extractHonoMiddleware(source: string): HonoMiddleware[] {
  const middlewares: HonoMiddleware[] = [];

  // Path-scoped: app.use('/api/*', cors())
  const pathRe = new RegExp(MIDDLEWARE_PATH_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(source)) !== null) {
    middlewares.push({
      path: match[1],
      name: match[2].trim(),
    });
  }

  // Global: app.use(logger())
  const globalRe = new RegExp(MIDDLEWARE_GLOBAL_RE.source, 'g');
  while ((match = globalRe.exec(source)) !== null) {
    const name = match[1].trim();
    // Skip if it looks like a path string (already captured above)
    if (/^['"`]/.test(name)) continue;
    middlewares.push({
      path: null,
      name,
    });
  }

  return middlewares;
}

export class HonoPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'hono',
    version: '1.0.0',
    priority: 25,
    category: 'framework',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('hono' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return 'hono' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'hono_route', category: 'hono', description: 'Hono route handler' },
        { name: 'hono_middleware', category: 'hono', description: 'Hono middleware usage' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    const routes = extractHonoRoutes(source);
    if (routes.length > 0) {
      result.frameworkRole = 'hono_route';
      for (const route of routes) {
        result.routes!.push({
          method: route.method,
          uri: route.path,
        });
      }
    }

    const middlewares = extractHonoMiddleware(source);
    if (middlewares.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'hono_middleware';
      for (const mw of middlewares) {
        result.routes!.push({
          method: 'USE',
          uri: mw.path ?? '/',
        });
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    return ok(edges);
  }
}
