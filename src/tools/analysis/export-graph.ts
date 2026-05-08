/**
 * Export the dependency graph in formats that external tools understand:
 *
 *   - graphml — Gephi, yEd, NetworkX (well-typed XML)
 *   - cypher  — Neo4j import script (CREATE statements)
 *   - obsidian — markdown vault, one note per file with [[wikilinks]]
 *
 * CRG v2.3.2 added a `visualize --format graphml|cypher|obsidian|svg` flag
 * for the same use case: "I want to take this graph somewhere else."
 * Visualization owns the SVG path; this module owns the structured-data
 * formats so analysts can crunch the graph in tools that already exist
 * (Cypher queries in Neo4j, betweenness-centrality in NetworkX, vault
 * exploration in Obsidian).
 *
 * The formats share one normalised internal shape so adding a new format
 * is a single function. We do NOT bundle bodies — only the graph
 * structure (file/symbol nodes + their edges) — to keep exports small.
 */
import type { Store } from '../../db/store.js';

export type ExportFormat = 'graphml' | 'cypher' | 'obsidian';

export interface ExportNode {
  id: string;
  kind: 'file' | 'symbol';
  label: string;
  /** Optional path attribute on file nodes — useful for downstream tools. */
  path?: string;
}

export interface ExportEdge {
  source: string;
  target: string;
  edge_type: string;
  confidence: number;
}

export interface NormalizedGraph {
  nodes: ExportNode[];
  edges: ExportEdge[];
}

export interface ExportResult {
  format: ExportFormat;
  /** Serialized graph in the requested format. */
  content: string;
  /** Counts for the caller to surface to the user. */
  node_count: number;
  edge_count: number;
}

interface RawNodeRow {
  id: number;
  node_type: string;
  ref_id: number;
}

interface RawEdgeRow {
  source_id: number;
  target_id: number;
  edge_type: string;
  confidence: number;
}

/**
 * Pull the full graph out of SQLite into the normalised shape. Caps at
 * `max_nodes` to keep exports of mega-repos within tool limits — graphml
 * over 50K nodes opens but Gephi grinds.
 */
export function buildExportGraph(store: Store, maxNodes = 5000): NormalizedGraph {
  const symbolRows = store.db
    .prepare(`
    SELECT n.id, n.node_type, n.ref_id
    FROM nodes n
    LIMIT ?
  `)
    .all(maxNodes) as RawNodeRow[];

  const symbolIdSet = new Set<number>();
  for (const r of symbolRows) symbolIdSet.add(r.id);

  const nodes: ExportNode[] = [];
  const idMap = new Map<number, string>();

  // Resolve each row into a label + path. Two queries instead of one big join
  // because the rows are already in memory and we want to keep this readable.
  const symLookup = store.db.prepare('SELECT symbol_id, name FROM symbols WHERE id = ?');
  const fileLookup = store.db.prepare('SELECT path FROM files WHERE id = ?');

  for (const r of symbolRows) {
    if (r.node_type === 'symbol') {
      const s = symLookup.get(r.ref_id) as { symbol_id: string; name: string } | undefined;
      if (!s) continue;
      nodes.push({ id: s.symbol_id, kind: 'symbol', label: s.name });
      idMap.set(r.id, s.symbol_id);
    } else if (r.node_type === 'file') {
      const f = fileLookup.get(r.ref_id) as { path: string } | undefined;
      if (!f) continue;
      const base = f.path.split('/').pop() ?? f.path;
      nodes.push({ id: f.path, kind: 'file', label: base, path: f.path });
      idMap.set(r.id, f.path);
    }
  }

  const edges: ExportEdge[] = [];
  const edgeRows = store.db
    .prepare(`
    SELECT e.source_node_id AS source_id, e.target_node_id AS target_id,
           et.name AS edge_type, e.confidence AS confidence
    FROM edges e
    JOIN edge_types et ON e.edge_type_id = et.id
    WHERE e.source_node_id IN (${[...symbolIdSet].join(',') || '0'})
      AND e.target_node_id IN (${[...symbolIdSet].join(',') || '0'})
  `)
    .all() as RawEdgeRow[];

  for (const e of edgeRows) {
    const src = idMap.get(e.source_id);
    const dst = idMap.get(e.target_id);
    if (!src || !dst) continue;
    edges.push({
      source: src,
      target: dst,
      edge_type: e.edge_type,
      confidence: e.confidence,
    });
  }

  return { nodes, edges };
}

// ─── GraphML ─────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toGraphML(graph: NormalizedGraph): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns">');
  lines.push('  <key id="kind" for="node" attr.name="kind" attr.type="string"/>');
  lines.push('  <key id="label" for="node" attr.name="label" attr.type="string"/>');
  lines.push('  <key id="path" for="node" attr.name="path" attr.type="string"/>');
  lines.push('  <key id="edge_type" for="edge" attr.name="edge_type" attr.type="string"/>');
  lines.push('  <key id="confidence" for="edge" attr.name="confidence" attr.type="double"/>');
  lines.push('  <graph edgedefault="directed">');

  for (const n of graph.nodes) {
    lines.push(`    <node id="${escapeXml(n.id)}">`);
    lines.push(`      <data key="kind">${escapeXml(n.kind)}</data>`);
    lines.push(`      <data key="label">${escapeXml(n.label)}</data>`);
    if (n.path) lines.push(`      <data key="path">${escapeXml(n.path)}</data>`);
    lines.push('    </node>');
  }
  for (const e of graph.edges) {
    lines.push(`    <edge source="${escapeXml(e.source)}" target="${escapeXml(e.target)}">`);
    lines.push(`      <data key="edge_type">${escapeXml(e.edge_type)}</data>`);
    lines.push(`      <data key="confidence">${e.confidence}</data>`);
    lines.push('    </edge>');
  }
  lines.push('  </graph>');
  lines.push('</graphml>');
  return lines.join('\n');
}

// ─── Cypher (Neo4j) ──────────────────────────────────────────────────────

function escapeCypher(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Sanitize a label so it's a valid Cypher identifier */
function cypherLabel(kind: string): string {
  return kind === 'file' ? 'File' : 'Symbol';
}

/** Sanitize an edge type for Cypher: must be ALL_CAPS, no special chars. */
function cypherRel(edgeType: string): string {
  return edgeType.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function toCypher(graph: NormalizedGraph): string {
  const lines: string[] = [];
  lines.push('// Cypher import script generated by trace-mcp');
  lines.push('// Run with: cypher-shell -f <this-file>');
  lines.push('');
  for (const n of graph.nodes) {
    const label = cypherLabel(n.kind);
    const props = [`id: '${escapeCypher(n.id)}'`, `label: '${escapeCypher(n.label)}'`];
    if (n.path) props.push(`path: '${escapeCypher(n.path)}'`);
    lines.push(`CREATE (:${label} { ${props.join(', ')} });`);
  }
  lines.push('');
  for (const e of graph.edges) {
    const rel = cypherRel(e.edge_type);
    lines.push(
      `MATCH (a { id: '${escapeCypher(e.source)}' }), (b { id: '${escapeCypher(e.target)}' }) ` +
        `CREATE (a)-[:${rel} { confidence: ${e.confidence} }]->(b);`,
    );
  }
  return lines.join('\n');
}

// ─── Obsidian vault ──────────────────────────────────────────────────────

/**
 * One note per file node, body lists wikilinks to every connected file.
 * Symbol nodes are listed inside their owning file note. The output is a
 * single multi-page document with `<!--FILE: path-->` separators so the
 * caller can split it into individual `.md` files inside a vault.
 */
function toObsidian(graph: NormalizedGraph): string {
  const fileNodes = graph.nodes.filter((n) => n.kind === 'file');
  const symbolsByFile = new Map<string, ExportNode[]>();
  // file path → file node — used to map a symbol's owning file to the
  // FileNode for slug lookup.
  const fileByPath = new Map<string, ExportNode>();
  for (const n of fileNodes) fileByPath.set(n.id, n);

  for (const n of graph.nodes) {
    if (n.kind === 'symbol') {
      // Heuristic: derive the owning file from the symbol_id prefix.
      const file = n.id.split('::')[0];
      const arr = symbolsByFile.get(file) ?? [];
      arr.push(n);
      symbolsByFile.set(file, arr);
    }
  }

  // Index edges by the owning *file* of their source — that's what the
  // file-per-note layout cares about. Symbol-to-symbol edges fold into
  // their owning file's outgoing list.
  const edgesByFile = new Map<string, ExportEdge[]>();
  for (const e of graph.edges) {
    const sourceFile = fileByPath.has(e.source) ? e.source : e.source.split('::')[0];
    const arr = edgesByFile.get(sourceFile) ?? [];
    arr.push(e);
    edgesByFile.set(sourceFile, arr);
  }

  // Map any node id (file or symbol) to the file slug it should link to.
  function targetSlugFor(id: string): { slug: string; label: string } {
    const direct = graph.nodes.find((n) => n.id === id);
    if (direct?.kind === 'file') return { slug: obsidianSlug(direct.id), label: direct.label };
    if (direct?.kind === 'symbol') {
      const file = id.split('::')[0];
      const fileNode = fileByPath.get(file);
      return {
        slug: obsidianSlug(fileNode?.id ?? file),
        label: `${fileNode?.label ?? file}#${direct.label}`,
      };
    }
    return { slug: obsidianSlug(id), label: id };
  }

  const out: string[] = [];
  for (const f of fileNodes) {
    const slug = obsidianSlug(f.id);
    out.push(`<!--FILE: ${slug}.md-->`);
    out.push(`# ${f.label}`);
    out.push('');
    out.push(`> path: \`${f.path ?? f.id}\``);
    out.push('');

    const syms = symbolsByFile.get(f.id) ?? [];
    if (syms.length > 0) {
      out.push('## Symbols');
      for (const s of syms) out.push(`- \`${s.label}\``);
      out.push('');
    }

    const edges = edgesByFile.get(f.id) ?? [];
    if (edges.length > 0) {
      out.push('## Outgoing edges');
      for (const e of edges) {
        const target = targetSlugFor(e.target);
        out.push(`- ${e.edge_type} → [[${target.slug}|${target.label}]]`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

/** Filename-safe slug for Obsidian. Trims to 80 chars, replaces / with __. */
function obsidianSlug(id: string): string {
  const replaced = id.replace(/[\\/]/g, '__').replace(/[^A-Za-z0-9._-]/g, '-');
  return replaced.length > 80 ? replaced.slice(0, 80) : replaced;
}

// ─── Public entry point ──────────────────────────────────────────────────

export function exportGraph(
  store: Store,
  format: ExportFormat,
  options: { max_nodes?: number } = {},
): ExportResult {
  const graph = buildExportGraph(store, options.max_nodes ?? 5000);
  let content: string;
  switch (format) {
    case 'graphml':
      content = toGraphML(graph);
      break;
    case 'cypher':
      content = toCypher(graph);
      break;
    case 'obsidian':
      content = toObsidian(graph);
      break;
  }
  return {
    format,
    content,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
  };
}
