/**
 * get_middleware_chain — Trace middleware for a given route URL.
 *
 * Express: app-level -> router-level -> route-level middleware.
 * NestJS: guards -> pipes -> interceptors -> filters.
 * Flask: global before_request -> blueprint before_request -> route.
 * FastAPI: app middleware -> router middleware -> Depends().
 * Django: settings.MIDDLEWARE -> view decorators.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { escapeRegExp } from '../utils/security.js';
import { notFound } from '../errors.js';

export interface MiddlewareEntry {
  name: string;
  scope: 'global' | 'router' | 'route' | 'guard' | 'pipe' | 'interceptor' | 'filter'
    | 'before_request' | 'after_request' | 'error_handler' | 'depends' | 'middleware' | 'view_decorator';
  path?: string;
  file?: string;
}

export interface MiddlewareChainResult {
  url: string;
  framework: 'express' | 'nestjs' | 'flask' | 'fastapi' | 'django' | 'unknown';
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
      .replace(/<[^>]+>/g, '\0PARAM\0')    // Django/Flask: <int:pk>
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
  const framework = detectFramework(allFiles);

  if (framework === 'express') {
    buildExpressChain(store, rootPath, url, allFiles, chain);
  } else if (framework === 'nestjs') {
    buildNestChain(store, rootPath, matchingRoute, allFiles, chain);
  } else if (framework === 'flask') {
    buildFlaskChain(store, rootPath, url, allFiles, chain);
  } else if (framework === 'fastapi') {
    buildFastAPIChain(store, rootPath, url, allFiles, chain);
  } else if (framework === 'django') {
    buildDjangoChain(store, rootPath, allFiles, chain);
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

type FileInfo = { id: number; path: string; framework_role: string | null };

function detectFramework(allFiles: FileInfo[]): MiddlewareChainResult['framework'] {
  for (const f of allFiles) {
    const role = f.framework_role;
    if (!role) continue;
    if (role.startsWith('nest_')) return 'nestjs';
    if (role.startsWith('express_')) return 'express';
    if (role.startsWith('flask_')) return 'flask';
    if (role.startsWith('fastapi_')) return 'fastapi';
    if (role.startsWith('django_') || role === 'url_config') return 'django';
  }
  return 'unknown';
}

function readSource(rootPath: string, filePath: string): string | undefined {
  try {
    return fs.readFileSync(path.resolve(rootPath, filePath), 'utf-8');
  } catch {
    return undefined;
  }
}

// ─── Express ──────────────────────────────────────────────────

function buildExpressChain(
  store: Store,
  rootPath: string,
  url: string,
  allFiles: FileInfo[],
  chain: MiddlewareEntry[],
): void {
  const GLOBAL_MW_RE = /(?:app|router)\s*\.\s*use\s*\(\s*([A-Za-z][\w.]*(?:\s*\(\s*[^)]*\))?)\s*[,)]/g;
  const PATH_MW_RE = /(?:app|router)\s*\.\s*use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z][\w.]*)/g;

  for (const file of allFiles) {
    if (file.framework_role !== 'express_router' && file.framework_role !== 'express_middleware') continue;
    const source = readSource(rootPath, file.path);
    if (!source) continue;

    let match: RegExpExecArray | null;
    const globalRe = new RegExp(GLOBAL_MW_RE.source, 'g');
    while ((match = globalRe.exec(source)) !== null) {
      const name = match[1].trim();
      if (/^['"`]/.test(name)) continue;
      chain.push({ name, scope: 'global', file: file.path });
    }

    const pathRe = new RegExp(PATH_MW_RE.source, 'g');
    while ((match = pathRe.exec(source)) !== null) {
      const mwPath = match[1];
      if (url.startsWith(mwPath)) {
        chain.push({ name: match[2], scope: 'router', path: mwPath, file: file.path });
      }
    }
  }
}

// ─── NestJS ───────────────────────────────────────────────────

function buildNestChain(
  store: Store,
  rootPath: string,
  route: { uri: string; file_id: number | null },
  allFiles: FileInfo[],
  chain: MiddlewareEntry[],
): void {
  const GUARDS_RE = /@UseGuards\(\s*([^)]+)\s*\)/g;
  const PIPES_RE = /@UsePipes\(\s*([^)]+)\s*\)/g;
  const INTERCEPTORS_RE = /@UseInterceptors\(\s*([^)]+)\s*\)/g;
  const FILTERS_RE = /@UseFilters\(\s*([^)]+)\s*\)/g;

  const controllerFiles = allFiles.filter((f) => f.framework_role === 'nest_controller');

  for (const file of controllerFiles) {
    const source = readSource(rootPath, file.path);
    if (!source) continue;

    const extractDecorators = (regex: RegExp, scope: MiddlewareEntry['scope']) => {
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

// ─── Flask ────────────────────────────────────────────────────

function buildFlaskChain(
  store: Store,
  rootPath: string,
  url: string,
  allFiles: FileInfo[],
  chain: MiddlewareEntry[],
): void {
  // Leverage existing flask_before_request and flask_error_handler edges
  const beforeEdges = store.getEdgesByType('flask_before_request');
  for (const edge of beforeEdges) {
    const ref = store.getNodeRef(edge.source_node_id);
    if (!ref) continue;
    let filePath = '';
    let name = 'before_request';
    if (ref.nodeType === 'symbol') {
      const sym = store.getSymbolById(ref.refId);
      if (sym) {
        name = sym.name;
        const f = store.getFileById(sym.file_id);
        filePath = f?.path ?? '';
      }
    }
    chain.push({ name, scope: 'before_request', file: filePath });
  }

  const errorEdges = store.getEdgesByType('flask_error_handler');
  for (const edge of errorEdges) {
    const ref = store.getNodeRef(edge.source_node_id);
    if (!ref) continue;
    let name = 'error_handler';
    let filePath = '';
    if (ref.nodeType === 'symbol') {
      const sym = store.getSymbolById(ref.refId);
      if (sym) {
        name = sym.name;
        const f = store.getFileById(sym.file_id);
        filePath = f?.path ?? '';
      }
    }
    chain.push({ name, scope: 'error_handler', file: filePath });
  }

  // Also scan for route-level decorators in matching route files
  for (const file of allFiles) {
    if (file.framework_role !== 'flask_routes') continue;
    const source = readSource(rootPath, file.path);
    if (!source) continue;

    // @login_required, @auth.login_required etc. before route handlers
    const decoratorRe = /@([\w.]+)\s*(?:\([^)]*\))?\s*\n\s*(?:@\w[\w.]*\s*(?:\([^)]*\))?\s*\n\s*)*def\s+\w+/g;
    let m: RegExpExecArray | null;
    while ((m = decoratorRe.exec(source)) !== null) {
      const dec = m[1];
      if (['app.route', 'bp.route', 'blueprint.route'].some((r) => dec.includes(r))) continue;
      if (dec.includes('route')) continue;
      chain.push({ name: `@${dec}`, scope: 'view_decorator', file: file.path });
    }
  }
}

// ─── FastAPI ──────────────────────────────────────────────────

function buildFastAPIChain(
  store: Store,
  rootPath: string,
  url: string,
  allFiles: FileInfo[],
  chain: MiddlewareEntry[],
): void {
  // Scan for app.add_middleware() calls
  for (const file of allFiles) {
    if (file.framework_role !== 'fastapi_routes' && file.framework_role !== 'fastapi_app') continue;
    const source = readSource(rootPath, file.path);
    if (!source) continue;

    // app.add_middleware(CORSMiddleware, ...) or app.add_middleware(Middleware)
    const addMwRe = /(?:app|router)\s*\.\s*add_middleware\s*\(\s*([\w.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = addMwRe.exec(source)) !== null) {
      chain.push({ name: m[1], scope: 'middleware', file: file.path });
    }
  }

  // Leverage fastapi_depends edges for route-level dependency chain
  const dependsEdges = store.getEdgesByType('fastapi_depends');
  for (const edge of dependsEdges) {
    const ref = store.getNodeRef(edge.source_node_id);
    if (!ref) continue;
    let name = 'Depends';
    let filePath = '';
    if (ref.nodeType === 'symbol') {
      const sym = store.getSymbolById(ref.refId);
      if (sym) {
        name = sym.name;
        const f = store.getFileById(sym.file_id);
        filePath = f?.path ?? '';
      }
    }
    chain.push({ name, scope: 'depends', file: filePath });
  }
}

// ─── Django ───────────────────────────────────────────────────

function buildDjangoChain(
  store: Store,
  rootPath: string,
  allFiles: FileInfo[],
  chain: MiddlewareEntry[],
): void {
  // 1. settings.py MIDDLEWARE list
  for (const file of allFiles) {
    if (!file.path.endsWith('settings.py') && !file.path.includes('settings/')) continue;
    const source = readSource(rootPath, file.path);
    if (!source) continue;

    // MIDDLEWARE = [ 'django.middleware.security.SecurityMiddleware', ... ]
    const mwMatch = source.match(/MIDDLEWARE\s*=\s*\[([\s\S]*?)\]/);
    if (!mwMatch) continue;

    const items = mwMatch[1].match(/['"]([^'"]+)['"]/g);
    if (items) {
      for (const item of items) {
        const name = item.replace(/['"]/g, '');
        chain.push({ name, scope: 'global', file: file.path });
      }
    }
  }

  // 2. View-level decorators (@login_required, @permission_required, etc.)
  for (const file of allFiles) {
    if (file.framework_role !== 'view') continue;
    const source = readSource(rootPath, file.path);
    if (!source) continue;

    const decoratorRe = /@([\w.]+)\s*(?:\([^)]*\))?\s*\n\s*(?:@\w[\w.]*\s*(?:\([^)]*\))?\s*\n\s*)*(?:def|class)\s+\w+/g;
    let m: RegExpExecArray | null;
    while ((m = decoratorRe.exec(source)) !== null) {
      const dec = m[1];
      // Skip routing decorators
      if (dec.includes('route') || dec.includes('api_view')) continue;
      chain.push({ name: `@${dec}`, scope: 'view_decorator', file: file.path });
    }
  }
}
