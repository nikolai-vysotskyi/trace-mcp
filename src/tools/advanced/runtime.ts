/**
 * Runtime Intelligence tools:
 * - get_runtime_profile: hot paths, latency distribution for a symbol/route
 * - get_change_risk: static + git + runtime risk scoring
 * - get_runtime_call_graph: actual call graph from traces
 * - get_endpoint_analytics: per-route request rate, latency, error rate
 * - get_runtime_dependencies: which services/DBs this code talks to
 */

import type { Store } from '../../db/store.js';
import { err, notFound, ok, type TraceMcpResult, validationError } from '../../errors.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface RuntimeProfileResult {
  target: { type: string; id: string; name: string };
  period: { since: string; until: string };
  total_calls: number;
  error_rate: number;
  latency: {
    p50_us: number;
    p95_us: number;
    p99_us: number;
    min_us: number;
    max_us: number;
    avg_us: number;
  };
  calls_per_hour: Array<{ bucket: string; count: number; errors: number }>;
}

interface RuntimeCallGraphNode {
  node_id: number;
  name: string;
  type: string;
  call_count: number;
  avg_duration_us: number;
  children: RuntimeCallGraphNode[];
}

interface RuntimeCallGraphResult {
  root: RuntimeCallGraphNode;
  total_nodes: number;
}

interface EndpointAnalyticsResult {
  route: { method: string; uri: string; handler?: string };
  period: { since: string; until: string };
  request_count: number;
  error_count: number;
  error_rate: number;
  latency: { p50_us: number; p95_us: number; p99_us: number; avg_us: number };
  callers: Array<{ service: string; call_count: number }>;
}

interface RuntimeDependency {
  name: string;
  kind: string;
  call_count: number;
  avg_latency_us: number;
  error_rate: number;
}

interface RuntimeDependenciesResult {
  target: { type: string; id: string };
  services: RuntimeDependency[];
}

// ════════════════════════════════════════════════════════════════════════
// 1. RUNTIME PROFILE
// ════════════════════════════════════════════════════════════════════════

export function getRuntimeProfile(
  store: Store,
  opts: { symbolId?: string; fqn?: string; routeUri?: string; since?: string },
): TraceMcpResult<RuntimeProfileResult> {
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();

  // Resolve target to node_id
  let nodeId: number | undefined;
  let targetName = '';
  let targetType = '';

  if (opts.symbolId) {
    const sym = store.getSymbolBySymbolId(opts.symbolId);
    if (!sym) return err(notFound(opts.symbolId));
    nodeId = store.getNodeId('symbol', sym.id);
    targetName = sym.name;
    targetType = 'symbol';
  } else if (opts.fqn) {
    const sym = store.getSymbolByFqn(opts.fqn);
    if (!sym) return err(notFound(opts.fqn));
    nodeId = store.getNodeId('symbol', sym.id);
    targetName = sym.name;
    targetType = 'symbol';
  } else if (opts.routeUri) {
    const route = store.findRouteByPattern(opts.routeUri, '*');
    if (!route) return err(notFound(opts.routeUri));
    nodeId = store.getNodeId('route', route.id);
    targetName = `${route.method} ${route.uri}`;
    targetType = 'route';
  } else {
    return err(validationError('Provide symbol_id, fqn, or route_uri'));
  }

  if (!nodeId) return err(notFound('Node not found in graph'));

  // Query aggregates
  const aggregates = store.db
    .prepare(`
    SELECT bucket, call_count, error_count, total_duration_us, min_duration_us, max_duration_us, percentiles
    FROM runtime_aggregates
    WHERE node_id = ? AND bucket >= ?
    ORDER BY bucket
  `)
    .all(nodeId, since.slice(0, 13)) as Array<{
    bucket: string;
    call_count: number;
    error_count: number;
    total_duration_us: number;
    min_duration_us: number;
    max_duration_us: number;
    percentiles: string | null;
  }>;

  const totalCalls = aggregates.reduce((s, a) => s + a.call_count, 0);
  const totalErrors = aggregates.reduce((s, a) => s + a.error_count, 0);
  const totalDuration = aggregates.reduce((s, a) => s + a.total_duration_us, 0);

  // Merge percentiles from all buckets (weighted)
  let p50 = 0;
  let p95 = 0;
  let p99 = 0;
  let minUs = Infinity;
  let maxUs = 0;

  for (const agg of aggregates) {
    if (agg.min_duration_us != null && agg.min_duration_us < minUs) minUs = agg.min_duration_us;
    if (agg.max_duration_us != null && agg.max_duration_us > maxUs) maxUs = agg.max_duration_us;
    if (agg.percentiles) {
      const pcts = JSON.parse(agg.percentiles) as Array<{ p: number; v: number }>;
      const weight = agg.call_count / Math.max(totalCalls, 1);
      for (const pc of pcts) {
        if (pc.p === 50) p50 += pc.v * weight;
        if (pc.p === 95) p95 += pc.v * weight;
        if (pc.p === 99) p99 += pc.v * weight;
      }
    }
  }

  return ok({
    target: {
      type: targetType,
      id: opts.symbolId ?? opts.fqn ?? opts.routeUri ?? '',
      name: targetName,
    },
    period: { since, until },
    total_calls: totalCalls,
    error_rate: totalCalls > 0 ? Math.round((totalErrors / totalCalls) * 1000) / 1000 : 0,
    latency: {
      p50_us: Math.round(p50),
      p95_us: Math.round(p95),
      p99_us: Math.round(p99),
      min_us: minUs === Infinity ? 0 : minUs,
      max_us: maxUs,
      avg_us: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0,
    },
    calls_per_hour: aggregates.map((a) => ({
      bucket: a.bucket,
      count: a.call_count,
      errors: a.error_count,
    })),
  });
}

// ════════════════════════════════════════════════════════════════════════
// 2. RUNTIME CALL GRAPH
// ════════════════════════════════════════════════════════════════════════

export function getRuntimeCallGraph(
  store: Store,
  opts: { symbolId?: string; fqn?: string; depth?: number; since?: string },
): TraceMcpResult<RuntimeCallGraphResult> {
  const maxDepth = opts.depth ?? 3;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let nodeId: number | undefined;
  let rootName = '';

  if (opts.symbolId) {
    const sym = store.getSymbolBySymbolId(opts.symbolId);
    if (!sym) return err(notFound(opts.symbolId));
    nodeId = store.getNodeId('symbol', sym.id);
    rootName = sym.name;
  } else if (opts.fqn) {
    const sym = store.getSymbolByFqn(opts.fqn);
    if (!sym) return err(notFound(opts.fqn));
    nodeId = store.getNodeId('symbol', sym.id);
    rootName = sym.name;
  } else {
    return err(validationError('Provide symbol_id or fqn'));
  }

  if (!nodeId) return err(notFound('Node not found'));

  // Find runtime call edges from traces (parent span → child span, both mapped)
  // Hoist prepared statement outside recursion to avoid re-preparing per node
  const childQuery = store.db.prepare(`
    SELECT
      child.mapped_node_id as child_node_id,
      COUNT(*) as call_count,
      AVG(child.duration_us) as avg_duration
    FROM runtime_spans parent
    JOIN runtime_spans child ON child.trace_id = parent.trace_id AND child.parent_span_id = parent.span_id
    WHERE parent.mapped_node_id = ?
      AND child.mapped_node_id IS NOT NULL
      AND child.mapped_node_id != ?
      AND parent.started_at >= ?
    GROUP BY child.mapped_node_id
    ORDER BY call_count DESC
    LIMIT 10
  `);

  const visited = new Set<number>();
  let totalNodes = 0;

  function buildTree(nId: number, currentDepth: number): RuntimeCallGraphNode {
    visited.add(nId);
    totalNodes++;

    const children: RuntimeCallGraphNode[] = [];
    if (currentDepth < maxDepth) {
      const childRows = childQuery.all(nId, nId, since) as Array<{
        child_node_id: number;
        call_count: number;
        avg_duration: number;
      }>;

      for (const row of childRows) {
        if (visited.has(row.child_node_id)) continue;
        const childTree = buildTree(row.child_node_id, currentDepth + 1);
        childTree.call_count = row.call_count;
        childTree.avg_duration_us = Math.round(row.avg_duration);
        children.push(childTree);
      }
    }

    // Resolve node name
    const ref = store.getNodeRef(nId);
    let name = `node:${nId}`;
    let type = 'unknown';
    if (ref) {
      type = ref.nodeType;
      if (ref.nodeType === 'symbol') {
        const sym = store.getSymbolById(ref.refId);
        if (sym) name = sym.name;
      } else if (ref.nodeType === 'file') {
        const file = store.getFileById(ref.refId);
        if (file) name = file.path;
      }
    }

    return { node_id: nId, name, type, call_count: 0, avg_duration_us: 0, children };
  }

  const root = buildTree(nodeId, 0);
  root.name = rootName;
  root.type = 'symbol';

  return ok({ root, total_nodes: totalNodes });
}

// ════════════════════════════════════════════════════════════════════════
// 3. ENDPOINT ANALYTICS
// ════════════════════════════════════════════════════════════════════════

export function getEndpointAnalytics(
  store: Store,
  opts: { uri?: string; method?: string; since?: string },
): TraceMcpResult<EndpointAnalyticsResult> {
  if (!opts.uri) return err(validationError('Provide uri'));

  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const route = store.findRouteByPattern(opts.uri, opts.method ?? '*');
  if (!route) return err(notFound(`${opts.method ?? '*'} ${opts.uri}`));

  const routeNodeId = store.getNodeId('route', route.id);
  if (!routeNodeId) return err(notFound('Route not in graph'));

  // Get aggregates for this route (per-bucket for percentile merging)
  const aggRows = store.db
    .prepare(`
    SELECT call_count, error_count, total_duration_us, min_duration_us, max_duration_us, percentiles
    FROM runtime_aggregates
    WHERE node_id = ? AND bucket >= ?
    ORDER BY bucket
  `)
    .all(routeNodeId, since.slice(0, 13)) as Array<{
    call_count: number;
    error_count: number;
    total_duration_us: number;
    min_duration_us: number | null;
    max_duration_us: number | null;
    percentiles: string | null;
  }>;

  const total = aggRows.reduce((s, a) => s + a.call_count, 0);
  const errors = aggRows.reduce((s, a) => s + a.error_count, 0);
  const totalDur = aggRows.reduce((s, a) => s + a.total_duration_us, 0);

  // Merge percentiles (weighted average across buckets)
  let p50 = 0;
  let p95 = 0;
  let p99 = 0;
  for (const agg of aggRows) {
    if (agg.percentiles && total > 0) {
      try {
        const pcts = JSON.parse(agg.percentiles) as Array<{ p: number; v: number }>;
        const weight = agg.call_count / total;
        for (const pc of pcts) {
          if (pc.p === 50) p50 += pc.v * weight;
          if (pc.p === 95) p95 += pc.v * weight;
          if (pc.p === 99) p99 += pc.v * weight;
        }
      } catch {
        /* corrupted percentiles, skip */
      }
    }
  }

  // Get caller services
  const callers = store.db
    .prepare(`
    SELECT service_name, COUNT(*) as cnt
    FROM runtime_spans
    WHERE mapped_node_id = ? AND started_at >= ? AND kind = 'server'
    GROUP BY service_name
    ORDER BY cnt DESC
  `)
    .all(routeNodeId, since) as Array<{ service_name: string; cnt: number }>;

  return ok({
    route: { method: route.method, uri: route.uri, handler: route.handler ?? undefined },
    period: { since, until: new Date().toISOString() },
    request_count: total,
    error_count: errors,
    error_rate: total > 0 ? Math.round((errors / total) * 1000) / 1000 : 0,
    latency: {
      p50_us: Math.round(p50),
      p95_us: Math.round(p95),
      p99_us: Math.round(p99),
      avg_us: total > 0 ? Math.round(totalDur / total) : 0,
    },
    callers: callers.map((c) => ({ service: c.service_name, call_count: c.cnt })),
  });
}

// ════════════════════════════════════════════════════════════════════════
// 4. RUNTIME DEPENDENCIES
// ════════════════════════════════════════════════════════════════════════

export function getRuntimeDependencies(
  store: Store,
  opts: { symbolId?: string; fqn?: string; filePath?: string },
): TraceMcpResult<RuntimeDependenciesResult> {
  let nodeId: number | undefined;
  let targetId = '';
  let targetType = '';

  if (opts.symbolId) {
    const sym = store.getSymbolBySymbolId(opts.symbolId);
    if (!sym) return err(notFound(opts.symbolId));
    nodeId = store.getNodeId('symbol', sym.id);
    targetId = opts.symbolId;
    targetType = 'symbol';
  } else if (opts.fqn) {
    const sym = store.getSymbolByFqn(opts.fqn);
    if (!sym) return err(notFound(opts.fqn));
    nodeId = store.getNodeId('symbol', sym.id);
    targetId = opts.fqn;
    targetType = 'symbol';
  } else if (opts.filePath) {
    const file = store.getFile(opts.filePath);
    if (!file) return err(notFound(opts.filePath));
    nodeId = store.getNodeId('file', file.id);
    targetId = opts.filePath;
    targetType = 'file';
  } else {
    return err(validationError('Provide symbol_id, fqn, or file_path'));
  }

  if (!nodeId) return err(notFound('Node not found'));

  // Find external services called from spans mapped to this node
  const services = store.db
    .prepare(`
    SELECT
      child.service_name as name,
      COUNT(*) as call_count,
      AVG(child.duration_us) as avg_latency,
      SUM(CASE WHEN child.status_code = 2 THEN 1 ELSE 0 END) as errors
    FROM runtime_spans parent
    JOIN runtime_spans child ON child.trace_id = parent.trace_id AND child.parent_span_id = parent.span_id
    WHERE parent.mapped_node_id = ?
      AND child.kind IN ('client', 'producer')
    GROUP BY child.service_name
    ORDER BY call_count DESC
  `)
    .all(nodeId) as Array<{
    name: string;
    call_count: number;
    avg_latency: number;
    errors: number;
  }>;

  // Also check runtime_services for kind info
  const serviceKinds = new Map<string, string>();
  const allServices = store.db.prepare('SELECT name, kind FROM runtime_services').all() as Array<{
    name: string;
    kind: string;
  }>;
  for (const s of allServices) serviceKinds.set(s.name, s.kind);

  return ok({
    target: { type: targetType, id: targetId },
    services: services.map((s) => ({
      name: s.name,
      kind: serviceKinds.get(s.name) ?? 'unknown',
      call_count: s.call_count,
      avg_latency_us: Math.round(s.avg_latency),
      error_rate: s.call_count > 0 ? Math.round((s.errors / s.call_count) * 1000) / 1000 : 0,
    })),
  });
}
