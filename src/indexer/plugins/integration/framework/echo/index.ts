/**
 * EchoPlugin -- detects Echo projects and extracts route handlers,
 * middleware usage, and route groups.
 *
 * Echo is a high-performance, minimalist Go web framework.
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
  RawRoute,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// e.GET("/path", handler), e.POST(...), etc.
const ROUTE_RE =
  /\b(\w+)\s*\.\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s*\(\s*"([^"]+)"/g;

// g := e.Group("/api")
const GROUP_RE = /\b(\w+)\s*\.\s*Group\s*\(\s*"([^"]+)"/g;

// e.Use(middleware) or e.Pre(middleware)
const MIDDLEWARE_RE = /\b(\w+)\s*\.\s*(?:Use|Pre)\s*\(\s*(\w[\w.]*)/g;

// e.Static("/assets", "./public")
const STATIC_RE = /\b(\w+)\s*\.\s*Static\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g;

interface EchoRoute {
  method: string;
  path: string;
  handler?: string;
}

interface EchoMiddleware {
  name: string;
}

interface EchoGroup {
  prefix: string;
}

/** Extract route definitions from Echo source code. */
function extractEchoRoutes(source: string): EchoRoute[] {
  const routes: EchoRoute[] = [];

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

/** Extract middleware Use()/Pre() calls from Echo source code. */
function extractEchoMiddleware(source: string): EchoMiddleware[] {
  const middlewares: EchoMiddleware[] = [];

  const mwRe = new RegExp(MIDDLEWARE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = mwRe.exec(source)) !== null) {
    middlewares.push({
      name: match[2].trim(),
    });
  }

  return middlewares;
}

/** Extract route group definitions from Echo source code. */
function extractEchoGroups(source: string): EchoGroup[] {
  const groups: EchoGroup[] = [];

  const groupRe = new RegExp(GROUP_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = groupRe.exec(source)) !== null) {
    groups.push({
      prefix: match[2],
    });
  }

  return groups;
}

export class EchoPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'echo',
    version: '1.0.0',
    priority: 25,
    category: 'framework',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    try {
      const goModPath = path.join(ctx.rootPath, 'go.mod');
      const content = fs.readFileSync(goModPath, 'utf-8');
      if (content.includes('github.com/labstack/echo')) return true;
    } catch {
      // go.mod not found, try go.sum
    }

    try {
      const goSumPath = path.join(ctx.rootPath, 'go.sum');
      const content = fs.readFileSync(goSumPath, 'utf-8');
      return content.includes('github.com/labstack/echo');
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'echo_route', category: 'echo', description: 'Echo route handler' },
        { name: 'echo_middleware', category: 'echo', description: 'Echo middleware usage' },
        { name: 'echo_group', category: 'echo', description: 'Echo route group' },
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

    const routes = extractEchoRoutes(source);
    if (routes.length > 0) {
      result.frameworkRole = 'echo_route';
      for (const route of routes) {
        result.routes!.push({
          method: route.method,
          uri: route.path,
          handler: route.handler,
        });
      }
    }

    const groups = extractEchoGroups(source);
    if (groups.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'echo_group';
      for (const group of groups) {
        result.routes!.push({
          method: 'USE',
          uri: group.prefix,
        });
      }
    }

    const middlewares = extractEchoMiddleware(source);
    if (middlewares.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'echo_middleware';
      for (const mw of middlewares) {
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
