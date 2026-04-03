/**
 * get_middleware_chain — Trace middleware for a given route URL.
 *
 * Express: app-level -> router-level -> route-level middleware.
 * NestJS: guards -> pipes -> interceptors -> filters.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { escapeRegExp } from '../utils/security.js';
import { notFound } from '../errors.js';

export interface MiddlewareEntry {
  name: string;
  scope: 'global' | 'router' | 'route' | 'guard' | 'pipe' | 'interceptor' | 'filter';
  path?: string;
  file?: string;
}

export interface MiddlewareChainResult {
  url: string;
  framework: 'express' | 'nestjs' | 'unknown';
  chain: MiddlewareEntry[];
}

/**
 * Build middleware chain for a given URL.
 * Inspects indexed routes and file content to trace middleware layers.
 */
export function getMiddlewareChain(
  store: Store,
  rootPath: string,
  url: string,
): TraceMcpResult<MiddlewareChainResult> {
  const allRoutes = store.getAllRoutes();

  // Find matching route
  const matchingRoute = allRoutes.find((r) => {
    const pattern = r.uri
      .replace(/:[^/]+/g, '\0PARAM\0')
      .replace(/\{[^}]+\}/g, '\0PARAM\0')
      .split('\0PARAM\0')
      .map(escapeRegExp)
      .join('[^/]+');
    return new RegExp(`^${pattern}$`).test(url) || r.uri === url;
  });

  if (!matchingRoute) {
    return err(notFound(url, ['No matching route found. Run reindex first.']));
  }

  const chain: MiddlewareEntry[] = [];
  const allFiles = store.getAllFiles();

  // Detect framework
  const hasNest = allFiles.some((f) => f.framework_role?.startsWith('nest_'));
  const hasExpress = allFiles.some((f) => f.framework_role?.startsWith('express_'));
  const framework: MiddlewareChainResult['framework'] = hasNest ? 'nestjs' : hasExpress ? 'express' : 'unknown';

  if (framework === 'express') {
    buildExpressChain(store, rootPath, url, allFiles, chain);
  } else if (framework === 'nestjs') {
    buildNestChain(store, rootPath, matchingRoute, allFiles, chain);
  }

  // Add route-level middleware from the route itself
  if (matchingRoute.middleware) {
    try {
      const parsed = JSON.parse(matchingRoute.middleware) as { middleware?: string[] };
      for (const mw of parsed.middleware ?? []) {
        chain.push({ name: mw, scope: 'route', path: matchingRoute.uri });
      }
    } catch {
      // ignore malformed middleware JSON
    }
  }

  return ok({ url, framework, chain });
}

function buildExpressChain(
  store: Store,
  rootPath: string,
  url: string,
  allFiles: { id: number; path: string; framework_role: string | null }[],
  chain: MiddlewareEntry[],
): void {
  const GLOBAL_MW_RE = /(?:app|router)\s*\.\s*use\s*\(\s*([A-Za-z][\w.]*(?:\s*\(\s*[^)]*\))?)\s*[,)]/g;
  const PATH_MW_RE = /(?:app|router)\s*\.\s*use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z][\w.]*)/g;

  for (const file of allFiles) {
    if (file.framework_role !== 'express_router' && file.framework_role !== 'express_middleware') continue;

    let source: string;
    try {
      source = fs.readFileSync(path.resolve(rootPath, file.path), 'utf-8');
    } catch { continue; }

    // Global middleware
    let match: RegExpExecArray | null;
    const globalRe = new RegExp(GLOBAL_MW_RE.source, 'g');
    while ((match = globalRe.exec(source)) !== null) {
      const name = match[1].trim();
      if (/^['"`]/.test(name)) continue;
      chain.push({ name, scope: 'global', file: file.path });
    }

    // Path-scoped middleware
    const pathRe = new RegExp(PATH_MW_RE.source, 'g');
    while ((match = pathRe.exec(source)) !== null) {
      const mwPath = match[1];
      if (url.startsWith(mwPath)) {
        chain.push({ name: match[2], scope: 'router', path: mwPath, file: file.path });
      }
    }
  }
}

function buildNestChain(
  store: Store,
  rootPath: string,
  route: { uri: string; file_id: number | null },
  allFiles: { id: number; path: string; framework_role: string | null }[],
  chain: MiddlewareEntry[],
): void {
  const GUARDS_RE = /@UseGuards\(\s*([^)]+)\s*\)/g;
  const PIPES_RE = /@UsePipes\(\s*([^)]+)\s*\)/g;
  const INTERCEPTORS_RE = /@UseInterceptors\(\s*([^)]+)\s*\)/g;
  const FILTERS_RE = /@UseFilters\(\s*([^)]+)\s*\)/g;

  // Find the controller file for this route
  const controllerFiles = allFiles.filter((f) => f.framework_role === 'nest_controller');

  for (const file of controllerFiles) {
    let source: string;
    try {
      source = fs.readFileSync(path.resolve(rootPath, file.path), 'utf-8');
    } catch { continue; }

    const extractDecorators = (
      regex: RegExp,
      scope: MiddlewareEntry['scope'],
    ) => {
      const re = new RegExp(regex.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const items = m[1].split(',').map((s) => s.trim()).filter(Boolean);
        for (const item of items) {
          chain.push({ name: item, scope, file: file.path });
        }
      }
    };

    extractDecorators(GUARDS_RE, 'guard');
    extractDecorators(PIPES_RE, 'pipe');
    extractDecorators(INTERCEPTORS_RE, 'interceptor');
    extractDecorators(FILTERS_RE, 'filter');
  }
}
