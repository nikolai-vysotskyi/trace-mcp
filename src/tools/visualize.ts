/**
 * Graph Visualization — generates self-contained HTML with embedded D3.js
 * and Mermaid diagram output for inline chat use.
 *
 * Performance: single batch query for nodes + edges, O(n) graph assembly.
 * Memory: streams HTML template, no large intermediate buffers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { validationError } from '../errors.js';
import type { Store, FileRow, SymbolRow, EdgeRow } from '../db/store.js';
// @ts-expect-error — picomatch has no bundled types (transitive dep of fast-glob)
import picomatch from 'picomatch';

// ── Types ──────────────────────────────────────────────────────────────────

export interface VisualizeGraphOptions {
  scope: string;            // file path, directory, or "project"
  depth?: number;           // max hops from scope (default: 2)
  layout?: 'force' | 'hierarchical' | 'radial';
  colorBy?: 'community' | 'language' | 'framework_role';
  includeEdges?: string[];  // filter edge types
  output?: string;          // output path
}

interface VizNode {
  id: string;
  label: string;
  type: 'file' | 'symbol';
  language: string | null;
  framework_role: string | null;
  community: number;
  symbolCount?: number;
  importance: number;
}

interface VizEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
}

interface VizCommunity {
  id: number;
  label: string;
  color: string;
}

export interface VisualizeGraphResult {
  outputPath: string;
  nodes: number;
  edges: number;
  communities: number;
}

export interface MermaidDiagramOptions {
  scope: string;
  depth?: number;
  maxNodes?: number;
  format?: 'mermaid' | 'dot';
}

export interface MermaidDiagramResult {
  diagram: string;
  format: string;
  nodes: number;
  edges: number;
}

// ── Community Detection (simple label propagation) ─────────────────────

function detectCommunities(
  nodeIds: string[],
  edges: VizEdge[],
): Map<string, number> {
  const labels = new Map<string, number>();
  nodeIds.forEach((id, i) => labels.set(id, i));

  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
  }

  // Label propagation — 5 iterations is usually enough
  for (let iter = 0; iter < 5; iter++) {
    for (const id of nodeIds) {
      const neighbors = adj.get(id);
      if (!neighbors || neighbors.length === 0) continue;
      // Most frequent label among neighbors
      const freq = new Map<number, number>();
      for (const n of neighbors) {
        const l = labels.get(n) ?? 0;
        freq.set(l, (freq.get(l) ?? 0) + 1);
      }
      let maxLabel = labels.get(id)!;
      let maxCount = 0;
      for (const [l, c] of freq) {
        if (c > maxCount) { maxCount = c; maxLabel = l; }
      }
      labels.set(id, maxLabel);
    }
  }

  // Normalize community IDs to 0..N
  const uniqueLabels = [...new Set(labels.values())];
  const remap = new Map<number, number>();
  uniqueLabels.forEach((l, i) => remap.set(l, i));
  for (const [id, l] of labels) labels.set(id, remap.get(l)!);

  return labels;
}

// ── Graph Data Builder ─────────────────────────────────────────────────

function buildGraphData(
  store: Store,
  opts: VisualizeGraphOptions,
): { nodes: VizNode[]; edges: VizEdge[]; communities: VizCommunity[] } {
  const scope = opts.scope;
  const depth = opts.depth ?? 2;
  const colorBy = opts.colorBy ?? 'community';

  // 1. Determine seed files
  let seedFiles: FileRow[];
  if (scope === 'project') {
    seedFiles = store.getAllFiles();
  } else {
    const allFiles = store.getAllFiles();
    // Check if scope is a file or directory pattern
    if (scope.includes('*')) {
      const isMatch = picomatch(scope, { matchBase: true });
      seedFiles = allFiles.filter((f) => isMatch(f.path));
    } else if (scope.endsWith('/') || !scope.includes('.')) {
      // Directory
      seedFiles = allFiles.filter((f) => f.path.startsWith(scope.replace(/\/$/, '')));
    } else {
      // Single file
      seedFiles = allFiles.filter((f) => f.path === scope);
    }
  }

  // Limit to prevent OOM on very large projects
  if (seedFiles.length > 500) seedFiles = seedFiles.slice(0, 500);

  // 2. Build file node map + collect node IDs for batch edge query
  const fileNodeIds: number[] = [];
  const fileNodeMap = new Map<number, FileRow>(); // nodeId → file
  const fileIdToNodeId = new Map<number, number>();

  for (const file of seedFiles) {
    const nodeId = store.getNodeId('file', file.id);
    if (!nodeId) continue;
    fileNodeIds.push(nodeId);
    fileNodeMap.set(nodeId, file);
    fileIdToNodeId.set(file.id, nodeId);
  }

  // 3. Batch fetch edges for all seed nodes (single query, no N+1)
  const allEdges = fileNodeIds.length > 0
    ? store.getEdgesForNodesBatch(fileNodeIds)
    : [];

  // Filter by edge type if specified
  const edgeFilter = opts.includeEdges ? new Set(opts.includeEdges) : null;
  const filteredEdges = edgeFilter
    ? allEdges.filter((e) => edgeFilter.has(e.edge_type_name))
    : allEdges;

  // 4. Collect all referenced node IDs (for depth expansion)
  const visitedNodes = new Set(fileNodeIds);
  const edgesInGraph: VizEdge[] = [];
  let frontier = new Set(fileNodeIds);

  for (let d = 0; d < depth && frontier.size > 0; d++) {
    const nextFrontier = new Set<number>();
    const batchEdges = d === 0
      ? filteredEdges
      : store.getEdgesForNodesBatch([...frontier]);

    for (const edge of batchEdges) {
      const otherNode = edge.pivot_node_id === edge.source_node_id
        ? edge.target_node_id
        : edge.source_node_id;

      if (!visitedNodes.has(otherNode) && visitedNodes.size < 500) {
        visitedNodes.add(otherNode);
        nextFrontier.add(otherNode);
      }
    }
    frontier = nextFrontier;
  }

  // 5. Resolve all node IDs to file info — batch lookup
  const nodeRefs = store.getNodeRefsBatch([...visitedNodes]);

  // Collect all file IDs and symbol IDs we need
  const fileIds = new Set<number>();
  const symbolIds = new Set<number>();
  for (const [, ref] of nodeRefs) {
    if (ref.nodeType === 'file') fileIds.add(ref.refId);
    else if (ref.nodeType === 'symbol') symbolIds.add(ref.refId);
  }

  const filesById = store.getFilesByIds([...fileIds]);
  const symbolsById = symbolIds.size > 0 ? store.getSymbolsByIds([...symbolIds]) : new Map();

  // 6. Build viz nodes
  const vizNodes: VizNode[] = [];
  const nodeIdToVizId = new Map<number, string>();

  for (const nodeId of visitedNodes) {
    const ref = nodeRefs.get(nodeId);
    if (!ref) continue;

    if (ref.nodeType === 'file') {
      const file = filesById.get(ref.refId);
      if (!file) continue;
      nodeIdToVizId.set(nodeId, file.path);
      vizNodes.push({
        id: file.path,
        label: path.basename(file.path),
        type: 'file',
        language: file.language,
        framework_role: file.framework_role,
        community: 0,
        importance: 0,
      });
    } else if (ref.nodeType === 'symbol') {
      const sym = symbolsById.get(ref.refId);
      if (!sym) continue;
      const file = store.getFileById(sym.file_id);
      nodeIdToVizId.set(nodeId, sym.symbol_id);
      vizNodes.push({
        id: sym.symbol_id,
        label: sym.name,
        type: 'symbol',
        language: file?.language ?? null,
        framework_role: file?.framework_role ?? null,
        community: 0,
        importance: 0,
      });
    }
  }

  // 7. Build viz edges from all edges between visited nodes
  const allEdgesForGraph = store.getEdgesForNodesBatch([...visitedNodes]);
  const edgeSeen = new Set<string>();
  for (const edge of allEdgesForGraph) {
    if (!visitedNodes.has(edge.source_node_id) || !visitedNodes.has(edge.target_node_id)) continue;
    if (edgeFilter && !edgeFilter.has(edge.edge_type_name)) continue;

    const sourceViz = nodeIdToVizId.get(edge.source_node_id);
    const targetViz = nodeIdToVizId.get(edge.target_node_id);
    if (!sourceViz || !targetViz || sourceViz === targetViz) continue;

    const edgeKey = `${sourceViz}→${targetViz}→${edge.edge_type_name}`;
    if (edgeSeen.has(edgeKey)) continue;
    edgeSeen.add(edgeKey);

    edgesInGraph.push({
      source: sourceViz,
      target: targetViz,
      type: edge.edge_type_name,
      weight: 1,
    });
  }

  // Deduplicate and sum weights
  const edgeMap = new Map<string, VizEdge>();
  for (const e of edgesInGraph) {
    const key = `${e.source}→${e.target}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight++;
    } else {
      edgeMap.set(key, { ...e });
    }
  }
  const dedupedEdges = [...edgeMap.values()];

  // 8. Detect communities
  const nodeVizIds = vizNodes.map((n) => n.id);
  const communityLabels = detectCommunities(nodeVizIds, dedupedEdges);
  for (const node of vizNodes) {
    node.community = communityLabels.get(node.id) ?? 0;
  }

  // Compute importance (degree centrality)
  const degree = new Map<string, number>();
  for (const e of dedupedEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const maxDegree = Math.max(1, ...degree.values());
  for (const node of vizNodes) {
    node.importance = Math.round(((degree.get(node.id) ?? 0) / maxDegree) * 100) / 100;
  }

  // Build community list
  const communitySet = new Set(vizNodes.map((n) => n.community));
  const COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
  const communities: VizCommunity[] = [...communitySet].map((id) => ({
    id,
    label: `group-${id}`,
    color: COLORS[id % COLORS.length],
  }));

  return { nodes: vizNodes, edges: dedupedEdges, communities };
}

// ── HTML Template ──────────────────────────────────────────────────────

function generateHtml(
  nodes: VizNode[],
  edges: VizEdge[],
  communities: VizCommunity[],
  layout: string,
): string {
  const data = JSON.stringify({ nodes, edges, communities });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>trace-mcp Graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; overflow: hidden; }
  #controls { position: fixed; top: 12px; left: 12px; z-index: 10; display: flex; gap: 8px; align-items: center; }
  #controls select, #controls input, #controls button {
    background: #16213e; border: 1px solid #0f3460; color: #eee; padding: 6px 10px; border-radius: 4px; font-size: 13px;
  }
  #controls input { width: 200px; }
  #controls button:hover { background: #0f3460; cursor: pointer; }
  #stats { position: fixed; bottom: 12px; left: 12px; z-index: 10; font-size: 12px; color: #888; }
  .tooltip {
    position: absolute; background: #16213e; color: #eee; padding: 10px 14px; border-radius: 6px;
    font-size: 12px; pointer-events: none; border: 1px solid #0f3460; max-width: 300px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
  .tooltip strong { color: #e94560; }
  svg { width: 100vw; height: 100vh; }
  .link { stroke-opacity: 0.4; }
  .link:hover { stroke-opacity: 1; }
  .node text { font-size: 10px; fill: #ccc; pointer-events: none; }
  .node circle { stroke: #fff; stroke-width: 1px; cursor: pointer; }
  .node circle:hover { stroke-width: 2.5px; }
  .node.dimmed circle { opacity: 0.15; }
  .node.dimmed text { opacity: 0.15; }
  .link.dimmed { stroke-opacity: 0.05; }
</style>
</head>
<body>
<div id="controls">
  <select id="colorBy">
    <option value="community">Color: Community</option>
    <option value="language">Color: Language</option>
    <option value="framework_role">Color: Role</option>
  </select>
  <input id="search" type="text" placeholder="Filter nodes\u2026">
  <button id="export-svg">Export SVG</button>
  <button id="export-mermaid">Export Mermaid</button>
</div>
<div id="stats"></div>
<div id="tooltip" class="tooltip" style="display:none"></div>
<svg id="graph"></svg>
<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const DATA = ${data};
const LAYOUT = ${JSON.stringify(layout)};
const width = window.innerWidth, height = window.innerHeight;
const svg = d3.select('#graph').attr('viewBox', [0, 0, width, height]);
const g = svg.append('g');

// Zoom
const zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', (e) => g.attr('transform', e.transform));
svg.call(zoom);

// Color scales
const communityColor = d3.scaleOrdinal(DATA.communities.map(c=>c.color)).domain(DATA.communities.map(c=>c.id));
const langColors = d3.scaleOrdinal(d3.schemeTableau10);
const roleColors = d3.scaleOrdinal(d3.schemePastel1);

function getColor(d) {
  const mode = document.getElementById('colorBy').value;
  if (mode === 'language') return langColors(d.language || 'unknown');
  if (mode === 'framework_role') return roleColors(d.framework_role || 'none');
  return communityColor(d.community);
}

// Force simulation
const simulation = d3.forceSimulation(DATA.nodes)
  .force('link', d3.forceLink(DATA.edges).id(d => d.id).distance(80).strength(0.3))
  .force('charge', d3.forceManyBody().strength(-200))
  .force('center', d3.forceCenter(width/2, height/2))
  .force('collision', d3.forceCollide().radius(d => 6 + d.importance * 14));

const link = g.append('g').selectAll('line')
  .data(DATA.edges).join('line')
  .attr('class', 'link')
  .attr('stroke', '#555')
  .attr('stroke-width', d => Math.sqrt(d.weight));

const node = g.append('g').selectAll('g')
  .data(DATA.nodes).join('g')
  .attr('class', 'node')
  .call(d3.drag().on('start', dragStarted).on('drag', dragged).on('end', dragEnded));

node.append('circle')
  .attr('r', d => 4 + d.importance * 12)
  .attr('fill', d => getColor(d));

node.append('text')
  .attr('dx', d => 6 + d.importance * 12)
  .attr('dy', 3)
  .text(d => d.label);

// Tooltip
const tooltip = document.getElementById('tooltip');
node.on('mouseover', (e, d) => {
  tooltip.style.display = 'block';
  tooltip.innerHTML = '<strong>' + d.label + '</strong><br>'
    + 'Type: ' + d.type + '<br>'
    + (d.language ? 'Lang: ' + d.language + '<br>' : '')
    + (d.framework_role ? 'Role: ' + d.framework_role + '<br>' : '')
    + 'Community: ' + d.community + '<br>'
    + 'Importance: ' + d.importance;
}).on('mousemove', (e) => {
  tooltip.style.left = (e.pageX + 12) + 'px';
  tooltip.style.top = (e.pageY - 12) + 'px';
}).on('mouseout', () => { tooltip.style.display = 'none'; });

// Click: highlight connected
node.on('click', (e, d) => {
  const connected = new Set([d.id]);
  DATA.edges.forEach(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (s === d.id) connected.add(t);
    if (t === d.id) connected.add(s);
  });
  node.classed('dimmed', n => !connected.has(n.id));
  link.classed('dimmed', l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return !connected.has(s) || !connected.has(t);
  });
});

svg.on('click', (e) => {
  if (e.target === svg.node()) {
    node.classed('dimmed', false);
    link.classed('dimmed', false);
  }
});

// Search
document.getElementById('search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  node.classed('dimmed', d => q && !d.label.toLowerCase().includes(q) && !d.id.toLowerCase().includes(q));
});

// Color switch
document.getElementById('colorBy').addEventListener('change', () => {
  node.select('circle').attr('fill', d => getColor(d));
});

// Export SVG
document.getElementById('export-svg').addEventListener('click', () => {
  const svgData = new XMLSerializer().serializeToString(document.getElementById('graph'));
  const blob = new Blob([svgData], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'graph.svg'; a.click();
});

// Export Mermaid
document.getElementById('export-mermaid').addEventListener('click', () => {
  let md = 'graph LR\\n';
  const safe = (s) => s.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 40);
  DATA.edges.forEach(e => {
    const s = typeof e.source === 'object' ? e.source.id : e.source;
    const t = typeof e.target === 'object' ? e.target.id : e.target;
    md += '  ' + safe(s) + ' --> ' + safe(t) + '\\n';
  });
  navigator.clipboard.writeText(md).then(() => alert('Mermaid copied to clipboard'));
});

simulation.on('tick', () => {
  link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
  node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
});

function dragStarted(e, d) { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
function dragged(e, d) { d.fx = e.x; d.fy = e.y; }
function dragEnded(e, d) { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }

document.getElementById('stats').textContent = DATA.nodes.length + ' nodes, ' + DATA.edges.length + ' edges, ' + DATA.communities.length + ' communities';
</script>
</body>
</html>`;
}

// ── Tool Entry Points ──────────────────────────────────────────────────

export function visualizeGraph(
  store: Store,
  opts: VisualizeGraphOptions,
): TraceMcpResult<VisualizeGraphResult> {
  const { nodes, edges, communities } = buildGraphData(store, opts);

  if (nodes.length === 0) {
    return err(validationError('No nodes found for the given scope. Try a broader scope or ensure the project is indexed.'));
  }

  const layout = opts.layout ?? 'force';
  const html = generateHtml(nodes, edges, communities, layout);
  const outputPath = opts.output ?? path.join(process.env.TMPDIR ?? '/tmp', 'trace-mcp-graph.html');

  fs.writeFileSync(outputPath, html, 'utf-8');

  return ok({
    outputPath,
    nodes: nodes.length,
    edges: edges.length,
    communities: communities.length,
  });
}

export function getDependencyDiagram(
  store: Store,
  opts: MermaidDiagramOptions,
): TraceMcpResult<MermaidDiagramResult> {
  const { nodes, edges } = buildGraphData(store, {
    scope: opts.scope,
    depth: opts.depth ?? 2,
  });

  const maxNodes = opts.maxNodes ?? 30;
  const format = opts.format ?? 'mermaid';

  // Trim to maxNodes by importance
  const sorted = [...nodes].sort((a, b) => b.importance - a.importance);
  const topNodes = sorted.slice(0, maxNodes);
  const nodeSet = new Set(topNodes.map((n) => n.id));
  const filteredEdges = edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target));

  if (format === 'dot') {
    const lines = ['digraph G {', '  rankdir=LR;', '  node [shape=box, style=rounded];'];
    for (const n of topNodes) {
      const safeId = n.id.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${safeId} [label="${n.label}"];`);
    }
    for (const e of filteredEdges) {
      const src = e.source.replace(/[^a-zA-Z0-9_]/g, '_');
      const tgt = e.target.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${src} -> ${tgt} [label="${e.type}"];`);
    }
    lines.push('}');
    return ok({ diagram: lines.join('\n'), format: 'dot', nodes: topNodes.length, edges: filteredEdges.length });
  }

  // Mermaid
  const lines = ['graph LR'];
  const safeId = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 40);
  for (const n of topNodes) {
    lines.push(`  ${safeId(n.id)}[${n.label}]`);
  }
  for (const e of filteredEdges) {
    lines.push(`  ${safeId(e.source)} -->|${e.type}| ${safeId(e.target)}`);
  }

  return ok({
    diagram: lines.join('\n'),
    format: 'mermaid',
    nodes: topNodes.length,
    edges: filteredEdges.length,
  });
}
