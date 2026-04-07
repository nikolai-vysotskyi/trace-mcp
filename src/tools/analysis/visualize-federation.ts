/**
 * Federation Topology Visualization — interactive HTML graph of services and their API connections.
 *
 * Services are nodes (sized by endpoint count, colored by health).
 * Cross-service edges show API call relationships with call counts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ok, err, type TraceMcpResult } from '../../errors.js';
import { validationError } from '../../errors.js';
import type { TopologyStore } from '../../topology/topology-db.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface FedVizNode {
  id: string;
  label: string;
  endpointCount: number;
  clientCallCount: number;
  linkedCallsPercent: number;
  health: 'healthy' | 'warning' | 'critical';
  repo: string;
  serviceType: string | null;
}

interface FedVizEdge {
  source: string;
  target: string;
  callCount: number;
  methods: string[];
  confidence: number;
}

interface VisualizeFederationResult {
  outputPath: string;
  services: number;
  edges: number;
}

// ════════════════════════════════════════════════════════════════════════
// BUILD GRAPH DATA
// ════════════════════════════════════════════════════════════════════════

function buildFederationData(topoStore: TopologyStore): { nodes: FedVizNode[]; edges: FedVizEdge[] } {
  const services = topoStore.getAllServices();
  const allEndpoints = topoStore.getAllEndpoints();
  const crossEdges = topoStore.getAllCrossServiceEdges();
  const repos = topoStore.getAllFederatedRepos();

  // Build repo lookup: repo_root → repo_name
  const repoNameByRoot = new Map(repos.map((r) => [r.repo_root, r.name]));

  // Build nodes
  const nodes: FedVizNode[] = services.map((svc) => {
    const endpoints = allEndpoints.filter((e) => e.service_id === svc.id);
    const endpointIds = new Set(endpoints.map((e) => e.id));

    // Count client calls targeting this service's endpoints
    let clientCallCount = 0;
    let linkedCount = 0;
    // Use cross-service edges as proxy
    const incomingEdges = crossEdges.filter((e) => e.target_service_id === svc.id);
    for (const edge of incomingEdges) {
      clientCallCount++;
      if (edge.confidence >= 0.7) linkedCount++;
    }

    const linkedPercent = endpoints.length > 0
      ? Math.round((linkedCount / Math.max(endpoints.length, 1)) * 100)
      : 0;

    const health: FedVizNode['health'] = endpoints.length === 0 ? 'critical'
      : linkedPercent >= 80 ? 'healthy'
      : linkedPercent >= 50 ? 'warning'
      : 'critical';

    return {
      id: svc.name,
      label: svc.name,
      endpointCount: endpoints.length,
      clientCallCount,
      linkedCallsPercent: linkedPercent,
      health,
      repo: repoNameByRoot.get(svc.repo_root) ?? svc.repo_root,
      serviceType: svc.service_type,
    };
  });

  // Build edges: aggregate cross-service edges by source+target
  const edgeMap = new Map<string, FedVizEdge>();
  for (const edge of crossEdges) {
    const sourceSvc = services.find((s) => s.id === edge.source_service_id);
    const targetSvc = services.find((s) => s.id === edge.target_service_id);
    if (!sourceSvc || !targetSvc) continue;

    const key = `${sourceSvc.name}→${targetSvc.name}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        source: sourceSvc.name,
        target: targetSvc.name,
        callCount: 0,
        methods: [],
        confidence: 0,
      });
    }
    const e = edgeMap.get(key)!;
    e.callCount++;
    e.confidence = Math.max(e.confidence, edge.confidence);
    if (edge.edge_type && !e.methods.includes(edge.edge_type)) {
      e.methods.push(edge.edge_type);
    }
  }

  return { nodes, edges: [...edgeMap.values()] };
}

// ════════════════════════════════════════════════════════════════════════
// HTML GENERATION
// ════════════════════════════════════════════════════════════════════════

function generateFederationHtml(nodes: FedVizNode[], edges: FedVizEdge[], layout: string): string {
  const healthColors: Record<string, string> = {
    healthy: '#22c55e',
    warning: '#f59e0b',
    critical: '#ef4444',
  };

  const data = JSON.stringify({ nodes, edges });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Federation Topology — trace-mcp</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; overflow: hidden; }
  #graph { width: 100vw; height: 100vh; }
  #stats { position: fixed; top: 12px; left: 12px; background: rgba(15,23,42,0.9); padding: 8px 14px; border-radius: 8px; font-size: 13px; border: 1px solid #334155; z-index: 10; }
  #legend { position: fixed; bottom: 12px; left: 12px; background: rgba(15,23,42,0.9); padding: 8px 14px; border-radius: 8px; font-size: 12px; border: 1px solid #334155; z-index: 10; }
  .legend-item { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
  .tooltip { position: fixed; background: #1e293b; border: 1px solid #475569; border-radius: 6px; padding: 8px 12px; font-size: 12px; pointer-events: none; z-index: 100; display: none; max-width: 300px; }
  .tooltip b { color: #38bdf8; }
  svg text { font-family: inherit; }
</style>
</head>
<body>
<div id="stats"></div>
<div id="legend">
  <div class="legend-item"><div class="legend-dot" style="background:${healthColors.healthy}"></div> Healthy (&ge;80% linked)</div>
  <div class="legend-item"><div class="legend-dot" style="background:${healthColors.warning}"></div> Warning (50-80% linked)</div>
  <div class="legend-item"><div class="legend-dot" style="background:${healthColors.critical}"></div> Critical (&lt;50% linked)</div>
</div>
<div class="tooltip" id="tooltip"></div>
<svg id="graph"></svg>
<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const DATA = ${data};
const COLORS = ${JSON.stringify(healthColors)};
const width = window.innerWidth;
const height = window.innerHeight;

const svg = d3.select('#graph').attr('width', width).attr('height', height);
const g = svg.append('g');

// Zoom
svg.call(d3.zoom().scaleExtent([0.1, 4]).on('zoom', (e) => g.attr('transform', e.transform)));

// Arrow markers
svg.append('defs').selectAll('marker')
  .data(['arrow']).enter().append('marker')
  .attr('id', d => d).attr('viewBox', '0 -5 10 10')
  .attr('refX', 20).attr('refY', 0)
  .attr('markerWidth', 8).attr('markerHeight', 8)
  .attr('orient', 'auto')
  .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#64748b');

const simulation = d3.forceSimulation(DATA.nodes)
  .force('link', d3.forceLink(DATA.edges).id(d => d.id).distance(180))
  .force('charge', d3.forceManyBody().strength(-400))
  .force('center', d3.forceCenter(width / 2, height / 2))
  .force('collision', d3.forceCollide().radius(d => 20 + d.endpointCount * 2));

// Edges
const link = g.append('g').selectAll('line')
  .data(DATA.edges).enter().append('line')
  .attr('stroke', '#475569')
  .attr('stroke-width', d => Math.max(1, Math.min(d.callCount, 8)))
  .attr('stroke-opacity', 0.6)
  .attr('marker-end', 'url(#arrow)');

// Edge labels
const edgeLabels = g.append('g').selectAll('text')
  .data(DATA.edges).enter().append('text')
  .text(d => d.callCount > 1 ? d.callCount + ' calls' : '1 call')
  .attr('font-size', 10).attr('fill', '#94a3b8').attr('text-anchor', 'middle');

// Nodes
const node = g.append('g').selectAll('g')
  .data(DATA.nodes).enter().append('g')
  .call(d3.drag().on('start', dragStarted).on('drag', dragged).on('end', dragEnded));

node.append('circle')
  .attr('r', d => 12 + d.endpointCount * 1.5)
  .attr('fill', d => COLORS[d.health] || '#64748b')
  .attr('stroke', '#e2e8f0')
  .attr('stroke-width', 1.5)
  .attr('opacity', 0.85);

node.append('text')
  .text(d => d.label)
  .attr('dy', d => -(16 + d.endpointCount * 1.5))
  .attr('text-anchor', 'middle')
  .attr('font-size', 13)
  .attr('fill', '#e2e8f0')
  .attr('font-weight', 600);

// Tooltip
const tooltip = d3.select('#tooltip');
node.on('mouseover', (e, d) => {
  tooltip.style('display', 'block')
    .html('<b>' + d.label + '</b><br/>' +
      'Repo: ' + d.repo + '<br/>' +
      'Type: ' + (d.serviceType || 'auto-detected') + '<br/>' +
      'Endpoints: ' + d.endpointCount + '<br/>' +
      'Incoming calls: ' + d.clientCallCount + '<br/>' +
      'Linked: ' + d.linkedCallsPercent + '%<br/>' +
      'Health: ' + d.health);
}).on('mousemove', (e) => {
  tooltip.style('left', (e.clientX + 12) + 'px').style('top', (e.clientY + 12) + 'px');
}).on('mouseout', () => tooltip.style('display', 'none'));

simulation.on('tick', () => {
  link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
  edgeLabels.attr('x', d => (d.source.x + d.target.x) / 2)
    .attr('y', d => (d.source.y + d.target.y) / 2 - 6);
  node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
});

function dragStarted(e, d) { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
function dragged(e, d) { d.fx = e.x; d.fy = e.y; }
function dragEnded(e, d) { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }

document.getElementById('stats').textContent = DATA.nodes.length + ' services, ' + DATA.edges.length + ' edges';
</script>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════════════════════
// TOOL ENTRY POINT
// ════════════════════════════════════════════════════════════════════════

export function visualizeFederationTopology(
  topoStore: TopologyStore,
  opts?: { output?: string; layout?: string },
): TraceMcpResult<VisualizeFederationResult> {
  const { nodes, edges } = buildFederationData(topoStore);

  if (nodes.length === 0) {
    return err(validationError('No services found. Add repos to the federation first (federation_add_repo).'));
  }

  const layout = opts?.layout ?? 'force';
  const html = generateFederationHtml(nodes, edges, layout);
  const outputPath = opts?.output ?? path.join(process.env.TMPDIR ?? '/tmp', 'trace-mcp-federation.html');

  fs.writeFileSync(outputPath, html, 'utf-8');

  return ok({
    outputPath,
    services: nodes.length,
    edges: edges.length,
  });
}
