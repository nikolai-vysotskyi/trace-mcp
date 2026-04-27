/**
 * GinPlugin -- detects Gin projects and extracts route handlers,
 * middleware usage, and route groups.
 *
 * Gin is a high-performance HTTP web framework for Go.
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

// r.GET("/path", handler), r.POST(...), etc.
const ROUTE_RE = /\b(\w+)\s*\.\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any)\s*\(\s*"([^"]+)"/g;

// r.Group("/api") or v1 := r.Group("/v1")
const GROUP_RE = /\b(\w+)\s*\.\s*Group\s*\(\s*"([^"]+)"/g;

// r.Use(middleware) or group.Use(middleware)
const MIDDLEWARE_RE = /\b(\w+)\s*\.\s*Use\s*\(\s*(\w[\w.]*)/g;

// r.Static("/assets", "./public")
const STATIC_RE = /\b(\w+)\s*\.\s*Static\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g;

interface GinRoute {
  method: string;
  path: string;
  handler?: string;
}

interface GinMiddleware {
  name: string;
}

interface GinGroup {
  prefix: string;
}

/** Extract route definitions from Gin source code. */
function extractGinRoutes(source: string): GinRoute[] {
  const routes: GinRoute[] = [];

  const routeRe = new RegExp(ROUTE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = routeRe.exec(source)) !== null) {
    routes.push({
      method: match[2].toUpperCase(),
      path: match[3],
    });
  }

  // Static file serving
  const staticRe = new RegExp(STATIC_RE.source, 'g');
  while ((match = staticRe.exec(source)) !== null) {
    routes.push({
      method: 'GET',
      path: match[2],
    });
  }

  return routes;
}

/** Extract middleware Use() calls from Gin source code. */
function extractGinMiddleware(source: string): GinMiddleware[] {
  const middlewares: GinMiddleware[] = [];

  const mwRe = new RegExp(MIDDLEWARE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = mwRe.exec(source)) !== null) {
    middlewares.push({
      name: match[2].trim(),
    });
  }

  return middlewares;
}

/** Extract route group definitions from Gin source code. */
function extractGinGroups(source: string): GinGroup[] {
  const groups: GinGroup[] = [];

  const groupRe = new RegExp(GROUP_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = groupRe.exec(source)) !== null) {
    groups.push({
      prefix: match[2],
    });
  }

  return groups;
}

export class GinPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'gin',
    version: '1.0.0',
    priority: 25,
    category: 'framework',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    try {
      const goModPath = path.join(ctx.rootPath, 'go.mod');
      const content = fs.readFileSync(goModPath, 'utf-8');
      if (content.includes('github.com/gin-gonic/gin')) return true;
    } catch {
      // go.mod not found, try go.sum
    }

    try {
      const goSumPath = path.join(ctx.rootPath, 'go.sum');
      const content = fs.readFileSync(goSumPath, 'utf-8');
      return content.includes('github.com/gin-gonic/gin');
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'gin_route', category: 'gin', description: 'Gin route handler' },
        { name: 'gin_middleware', category: 'gin', description: 'Gin middleware usage' },
        { name: 'gin_group', category: 'gin', description: 'Gin route group' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'go') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    const routes = extractGinRoutes(source);
    if (routes.length > 0) {
      result.frameworkRole = 'gin_route';
      for (const route of routes) {
        result.routes!.push({
          method: route.method,
          uri: route.path,
          handler: route.handler,
        });
      }
    }

    const groups = extractGinGroups(source);
    if (groups.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'gin_group';
      for (const group of groups) {
        result.routes!.push({
          method: 'USE',
          uri: group.prefix,
        });
      }
    }

    const middlewares = extractGinMiddleware(source);
    if (middlewares.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'gin_middleware';
      for (const _mw of middlewares) {
        result.routes!.push({
          method: 'USE',
          uri: '/',
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
