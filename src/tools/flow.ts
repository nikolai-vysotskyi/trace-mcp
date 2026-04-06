/**
 * get_request_flow tool — traces a request from URL to full handler chain.
 * URL -> Route -> Middleware -> Controller -> FormRequest -> Model
 */
import type { Store, RouteRow } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';

interface RequestFlowStep {
  type: 'route' | 'middleware' | 'controller' | 'form_request' | 'model' | 'inertia_page';
  name: string;
  symbolId?: string;
  fqn?: string;
  details?: Record<string, unknown>;
}

interface RequestFlowResult {
  url: string;
  method: string;
  steps: RequestFlowStep[];
  _meta?: { warnings: string[] };
}

export function getRequestFlow(
  store: Store,
  url: string,
  method: string,
): TraceMcpResult<RequestFlowResult> {
  const normalizedMethod = method.toUpperCase();
  const steps: RequestFlowStep[] = [];
  const warnings: string[] = [];

  // 1. Find matching route
  const route = store.findRouteByPattern(url, normalizedMethod);
  if (!route) {
    return err(notFound(`route:${normalizedMethod} ${url}`));
  }

  steps.push({
    type: 'route',
    name: route.name ?? `${route.method} ${route.uri}`,
    details: {
      method: route.method,
      uri: route.uri,
      routeName: route.name,
    },
  });

  // 2. Parse middleware JSON and controller ref
  const { middleware, controllerRef } = parseRouteMiddleware(route);

  for (const m of middleware) {
    steps.push({ type: 'middleware', name: m });
  }

  // 3. Controller method
  const effectiveControllerRef = controllerRef ?? route.controller_symbol_id;
  if (effectiveControllerRef) {
    const ref = String(effectiveControllerRef);
    const [controllerFqn, actionName] = splitControllerRef(ref);

    const controllerSymbol = store.getSymbolByFqn(controllerFqn);
    const methodFqn = actionName ? `${controllerFqn}::${actionName}` : undefined;
    const methodSymbol = methodFqn ? store.getSymbolByFqn(methodFqn) : undefined;

    steps.push({
      type: 'controller',
      name: actionName ? `${controllerFqn}@${actionName}` : controllerFqn,
      symbolId: methodSymbol?.symbol_id ?? controllerSymbol?.symbol_id,
      fqn: methodFqn ?? controllerFqn,
      details: { action: actionName },
    });

    // 4. FormRequest — find validates_with edges from controller method
    // 5. Inertia — find inertia_renders edges from controller method OR class
    // Edges may be on the method or on the class symbol, so check both
    const symbolsToCheck = [methodSymbol, controllerSymbol].filter(Boolean) as typeof controllerSymbol[];
    const seenEdgeTypes = new Set<string>();

    // Collect all outgoing edges from both symbols, then batch resolve targets
    const allOutEdges: Array<{ edge: typeof store extends { getOutgoingEdges(n: number): infer R } ? (R extends Array<infer E> ? E : never) : never; }> = [];
    for (const sym of symbolsToCheck) {
      if (!sym) continue;
      const nid = store.getNodeId('symbol', sym.id);
      if (!nid) continue;
      const edges = store.getOutgoingEdges(nid);
      for (const e of edges) (allOutEdges as any[]).push(e);
    }

    const targetIds = allOutEdges.map((e: any) => e.target_node_id);
    const targetRefs = store.getNodeRefsBatch(targetIds);
    const symIds = [...targetRefs.values()].filter((r) => r.nodeType === 'symbol').map((r) => r.refId);
    const targetSymMap = symIds.length > 0 ? store.getSymbolsByIds(symIds) : new Map();
    const targetFileIds = [...new Set([...targetSymMap.values()].map((s) => s.file_id))];
    const targetFileMap = targetFileIds.length > 0 ? store.getFilesByIds(targetFileIds) : new Map();

    for (const edge of allOutEdges as any[]) {
      const ref = targetRefs.get(edge.target_node_id);
      if (!ref || ref.nodeType !== 'symbol') continue;
      const targetSym = targetSymMap.get(ref.refId);
      if (!targetSym) continue;

      if (edge.edge_type_name === 'validates_with' && !seenEdgeTypes.has('validates_with')) {
        seenEdgeTypes.add('validates_with');
        steps.push({
          type: 'form_request',
          name: targetSym.fqn ?? targetSym.name,
          symbolId: targetSym.symbol_id,
          fqn: targetSym.fqn ?? undefined,
        });
      }

      if (edge.edge_type_name === 'inertia_renders') {
        const meta = edge.metadata ? JSON.parse(edge.metadata) as Record<string, unknown> : {};
        const file = targetFileMap.get(targetSym.file_id);
        const alreadyAdded = steps.some(
          (s: any) => s.type === 'inertia_page' && s.details?.pageName === meta.pageName,
        );
        if (!alreadyAdded) {
          steps.push({
            type: 'inertia_page',
            name: targetSym.name,
            symbolId: targetSym.symbol_id,
            details: {
              pageName: meta.pageName,
              propNames: meta.propNames,
              filePath: file?.path,
            },
          });
        }
      }
    }
  }

  const result: RequestFlowResult = { url, method: normalizedMethod, steps };
  if (warnings.length > 0) {
    result._meta = { warnings };
  }
  return ok(result);
}

/** Parse the middleware JSON which may contain { middleware: [...], controllerRef: "..." }. */
function parseRouteMiddleware(route: RouteRow): {
  middleware: string[];
  controllerRef: string | null;
} {
  if (!route.middleware) return { middleware: [], controllerRef: null };

  try {
    const parsed = JSON.parse(route.middleware);
    if (Array.isArray(parsed)) {
      return { middleware: parsed, controllerRef: null };
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return {
        middleware: Array.isArray(parsed.middleware) ? parsed.middleware : [],
        controllerRef: parsed.controllerRef ?? null,
      };
    }
  } catch {
    // not JSON
  }
  return { middleware: [], controllerRef: null };
}

function splitControllerRef(ref: string): [string, string | undefined] {
  // "App\Http\Controllers\UserController::store"
  const lastSep = ref.lastIndexOf('::');
  if (lastSep > 0) {
    return [ref.substring(0, lastSep), ref.substring(lastSep + 2)];
  }
  return [ref, undefined];
}
