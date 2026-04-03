/**
 * ExpressPlugin — detects Express.js projects and extracts route registrations,
 * middleware, and router mounts.
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

const ROUTE_RE =
  /(?:app|router)\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const MIDDLEWARE_RE =
  /(?:app|router)\s*\.\s*use\s*\(\s*['"`]([^'"`]+)['"`]/g;
const GLOBAL_MIDDLEWARE_RE =
  /(?:app|router)\s*\.\s*use\s*\(\s*([A-Za-z][\w.]*(?:\s*\(\s*[^)]*\))?)\s*[,)]/g;

export interface ExpressRoute {
  method: string;
  path: string;
  line?: number;
}

export interface ExpressMiddleware {
  path: string;
  isGlobal: boolean;
  name?: string;
}

/** Extract route registrations from Express source code. */
export function extractExpressRoutes(source: string): ExpressRoute[] {
  const routes: ExpressRoute[] = [];
  const re = new RegExp(ROUTE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
    });
  }
  return routes;
}

/** Extract middleware use() calls with paths. */
export function extractExpressMiddleware(source: string): ExpressMiddleware[] {
  const middlewares: ExpressMiddleware[] = [];
  const pathRe = new RegExp(MIDDLEWARE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(source)) !== null) {
    middlewares.push({ path: match[1], isGlobal: false });
  }

  // Global middleware (no path string)
  const globalRe = new RegExp(GLOBAL_MIDDLEWARE_RE.source, 'g');
  while ((match = globalRe.exec(source)) !== null) {
    const name = match[1].trim();
    // Skip if it looks like a path string (already captured above)
    if (/^['"`]/.test(name)) continue;
    middlewares.push({ path: '/', isGlobal: true, name });
  }

  return middlewares;
}

export class ExpressPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'express',
    version: '1.0.0',
    priority: 25,
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('express' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return 'express' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'express_route', category: 'express', description: 'Express route handler' },
        { name: 'express_middleware', category: 'express', description: 'Express middleware' },
        { name: 'express_mounts', category: 'express', description: 'Router mount via app.use' },
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

    const routes = extractExpressRoutes(source);
    if (routes.length > 0) {
      result.frameworkRole = 'express_router';
      for (const route of routes) {
        result.routes!.push({
          method: route.method,
          uri: route.path,
        });
      }
    }

    const middlewares = extractExpressMiddleware(source);
    if (middlewares.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'express_middleware';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    // Express edge resolution is primarily file-level;
    // route -> handler symbol resolution would require call-graph analysis
    // which is beyond the scope of regex-based extraction.
    return ok(edges);
  }
}
