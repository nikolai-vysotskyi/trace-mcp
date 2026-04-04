/**
 * Django URL pattern extraction from urls.py files.
 *
 * Detects:
 * - path('route/', view, name='name') → RawRoute
 * - re_path(r'^pattern/$', view) → RawRoute
 * - url(r'^pattern/$', view) → RawRoute (Django 1.x compat)
 * - include('app.urls') → django_includes_urls edge
 * - Router-based DRF patterns: router.register('prefix', ViewSet)
 */
import type { RawRoute, RawEdge } from '../../../../plugin-api/types.js';

export interface UrlExtractionResult {
  routes: RawRoute[];
  edges: RawEdge[];
  warnings: string[];
}

/**
 * Extract URL patterns from a Django urls.py source file.
 */
export function extractUrlPatterns(
  source: string,
  filePath: string,
): UrlExtractionResult {
  const routes: RawRoute[] = [];
  const edges: RawEdge[] = [];
  const warnings: string[] = [];

  // Extract path() calls
  extractPathCalls(source, routes, edges);

  // Extract re_path() calls
  extractRePathCalls(source, routes);

  // Extract legacy url() calls (Django 1.x)
  extractLegacyUrlCalls(source, routes, edges);

  // Extract DRF router registrations
  extractDrfRouterPatterns(source, routes);

  return { routes, edges, warnings };
}

/**
 * Extract path('route/', view, name='name') patterns.
 * Also detects path('api/', include('app.urls')).
 */
function extractPathCalls(
  source: string,
  routes: RawRoute[],
  edges: RawEdge[],
): void {
  // path('uri', view_function_or_class, name='...')
  // path('uri', include('module.urls'))
  // Handler may contain nested parens like .as_view(), so allow them
  const pathRegex = /path\s*\(\s*['"]([^'"]*)['"]\s*,\s*([^,]+(?:\([^)]*\))?[^,]*)(?:\s*,\s*([^)]*))?\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = pathRegex.exec(source)) !== null) {
    const uri = match[1];
    const handler = match[2].trim();
    const extraArgs = match[3] || '';

    // Check if this is an include()
    const includeMatch = handler.match(/include\s*\(\s*['"]([^'"]+)['"]/);
    if (includeMatch) {
      edges.push({
        edgeType: 'django_includes_urls',
        metadata: {
          sourceFile: source,
          prefix: uri,
          includedModule: includeMatch[1],
        },
      });
      continue;
    }

    // Check for include() with namespace
    const includeNsMatch = handler.match(/include\s*\(\s*\(\s*['"]([^'"]+)['"].*?namespace\s*=\s*['"]([^'"]+)['"]/);
    if (includeNsMatch) {
      edges.push({
        edgeType: 'django_includes_urls',
        metadata: {
          prefix: uri,
          includedModule: includeNsMatch[1],
          namespace: includeNsMatch[2],
        },
      });
      continue;
    }

    // Regular view route
    const name = extractRouteName(extraArgs);
    const viewName = normalizeViewRef(handler);

    routes.push({
      method: 'GET', // Django path() handles all methods; default to GET
      uri: `/${uri}`.replace(/\/+/g, '/'),
      name: name ?? undefined,
      controllerSymbolId: viewName,
    });
  }
}

/**
 * Extract re_path(r'^pattern/$', view) patterns.
 */
function extractRePathCalls(
  source: string,
  routes: RawRoute[],
): void {
  const rePathRegex = /re_path\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([^,)]+)(?:\s*,\s*([^)]*))?\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = rePathRegex.exec(source)) !== null) {
    const pattern = match[1];
    const handler = match[2].trim();
    const extraArgs = match[3] || '';

    // Skip include() patterns
    if (handler.includes('include(')) continue;

    const name = extractRouteName(extraArgs);
    const viewName = normalizeViewRef(handler);
    const uri = regexPatternToUri(pattern);

    routes.push({
      method: 'GET',
      uri,
      name: name ?? undefined,
      controllerSymbolId: viewName,
    });
  }
}

/**
 * Extract legacy url(r'^pattern/$', view) patterns (Django 1.x).
 */
function extractLegacyUrlCalls(
  source: string,
  routes: RawRoute[],
  edges: RawEdge[],
): void {
  const urlRegex = /\burl\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([^,)]+)(?:\s*,\s*([^)]*))?\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(source)) !== null) {
    const pattern = match[1];
    const handler = match[2].trim();
    const extraArgs = match[3] || '';

    // Check for include()
    const includeMatch = handler.match(/include\s*\(\s*['"]([^'"]+)['"]/);
    if (includeMatch) {
      edges.push({
        edgeType: 'django_includes_urls',
        metadata: {
          prefix: regexPatternToUri(pattern),
          includedModule: includeMatch[1],
        },
      });
      continue;
    }

    const name = extractRouteName(extraArgs);
    const viewName = normalizeViewRef(handler);
    const uri = regexPatternToUri(pattern);

    routes.push({
      method: 'GET',
      uri,
      name: name ?? undefined,
      controllerSymbolId: viewName,
    });
  }
}

/**
 * Extract DRF router registrations:
 * router.register(r'users', UserViewSet, basename='user')
 */
function extractDrfRouterPatterns(
  source: string,
  routes: RawRoute[],
): void {
  const routerRegex = /(\w+)\.register\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*(\w+)(?:\s*,\s*([^)]*))?\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = routerRegex.exec(source)) !== null) {
    const prefix = match[2];
    const viewSetName = match[3];
    const extraArgs = match[4] || '';

    const basenameMatch = extraArgs.match(/basename\s*=\s*['"]([^'"]+)['"]/);
    const basename = basenameMatch?.[1] ?? prefix;

    // DRF ViewSet generates list/create/retrieve/update/destroy
    const viewSetRoutes: Array<{ method: string; suffix: string; action: string }> = [
      { method: 'GET', suffix: '/', action: 'list' },
      { method: 'POST', suffix: '/', action: 'create' },
      { method: 'GET', suffix: '/{pk}/', action: 'retrieve' },
      { method: 'PUT', suffix: '/{pk}/', action: 'update' },
      { method: 'PATCH', suffix: '/{pk}/', action: 'partial_update' },
      { method: 'DELETE', suffix: '/{pk}/', action: 'destroy' },
    ];

    for (const r of viewSetRoutes) {
      routes.push({
        method: r.method,
        uri: `/${prefix}${r.suffix}`.replace(/\/+/g, '/'),
        name: `${basename}-${r.action}`,
        controllerSymbolId: `${viewSetName}.${r.action}`,
      });
    }
  }
}

/** Extract name='...' from extra arguments. */
function extractRouteName(extraArgs: string): string | null {
  const nameMatch = extraArgs.match(/name\s*=\s*['"]([^'"]+)['"]/);
  return nameMatch ? nameMatch[1] : null;
}

/** Normalize a view reference to a clean handler name. */
function normalizeViewRef(handler: string): string {
  // views.user_list → views.user_list
  // UserView.as_view() → UserView
  let ref = handler.trim();
  ref = ref.replace(/\.as_view\s*\(\s*\)/, '');
  return ref;
}

/**
 * Convert a Django URL regex pattern to a URI-like string.
 * e.g., r'^users/(?P<pk>\d+)/$' → /users/{pk}/
 */
function regexPatternToUri(pattern: string): string {
  let uri = pattern;
  // Remove regex anchors
  uri = uri.replace(/^\^/, '').replace(/\$$/, '');
  // Convert named groups: (?P<name>...) → {name}
  uri = uri.replace(/\(\?P<(\w+)>[^)]+\)/g, '{$1}');
  // Convert unnamed groups
  uri = uri.replace(/\([^)]+\)/g, '{param}');
  // Ensure leading slash
  if (!uri.startsWith('/')) uri = `/${uri}`;
  return uri;
}
