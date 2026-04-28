/**
 * get_control_flow tool — build a Control Flow Graph for a function/method.
 *
 * Reads the symbol's source code and extracts CFG nodes and edges.
 * Returns JSON, Mermaid, or ASCII representation.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';
import { err, notFound, ok, type TraceMcpResult, validationError } from '../../errors.js';
import {
  type CFGResult,
  cfgToAscii,
  cfgToMermaid,
  extractCFG,
} from '../../indexer/cfg-extractor.js';

interface ControlFlowOptions {
  symbolId?: string;
  fqn?: string;
  format: 'json' | 'mermaid' | 'ascii';
  simplify: boolean;
}

interface ControlFlowResult {
  symbol: string;
  file: string;
  format: string;
  cfg: CFGResult | string;
  cyclomatic_complexity: number;
  paths: number;
  max_nesting: number;
}

export function getControlFlow(
  store: Store,
  projectRoot: string,
  options: ControlFlowOptions,
): TraceMcpResult<ControlFlowResult> {
  const { symbolId, fqn, format, simplify } = options;

  // Find the symbol
  type SymbolRow = {
    id: number;
    file_id: number;
    line_start?: number;
    line_end?: number;
    fqn?: string | null;
    name?: string;
  };
  type FileRow = { id: number; path: string };

  let symbol: SymbolRow | null = null;
  let file: FileRow | null = null;

  if (symbolId) {
    symbol =
      (store.getSymbolById?.(Number(symbolId)) as SymbolRow | null) ??
      (store.db
        .prepare('SELECT * FROM symbols WHERE symbol_id = ?')
        .get(symbolId) as SymbolRow | null);
  } else if (fqn) {
    symbol = store.db
      .prepare('SELECT * FROM symbols WHERE fqn = ? OR name = ? LIMIT 1')
      .get(fqn, fqn) as SymbolRow | null;
  }

  if (!symbol) {
    return err(notFound(`symbol:${symbolId ?? fqn}`));
  }

  file =
    (store.getFileById?.(symbol.file_id) as FileRow | null) ??
    (store.db.prepare('SELECT * FROM files WHERE id = ?').get(symbol.file_id) as FileRow | null);

  if (!file) {
    return err(notFound(`file for symbol`));
  }

  // Read the source
  const absPath = path.isAbsolute(file.path) ? file.path : path.join(projectRoot, file.path);

  if (!fs.existsSync(absPath)) {
    return err(validationError(`File not on disk: ${file.path}`));
  }

  const content = fs.readFileSync(absPath, 'utf-8');
  const lines = content.split('\n');

  const startLine = symbol.line_start ?? 1;
  const endLine = symbol.line_end ?? lines.length;
  const functionSource = lines.slice(startLine - 1, endLine).join('\n');

  // Extract CFG
  let cfg = extractCFG(functionSource, startLine);

  // Simplify: collapse sequential statement nodes
  if (simplify) {
    cfg = simplifyCFG(cfg);
  }

  // Format output
  let output: CFGResult | string;
  switch (format) {
    case 'mermaid':
      output = cfgToMermaid(cfg);
      break;
    case 'ascii':
      output = cfgToAscii(cfg);
      break;
    default:
      output = cfg;
  }

  return ok({
    symbol: symbol.fqn ?? symbol.name ?? '',
    file: file.path,
    format,
    cfg: output,
    cyclomatic_complexity: cfg.cyclomatic_complexity,
    paths: cfg.paths,
    max_nesting: cfg.max_nesting,
  });
}

/** Collapse sequential statement nodes into one */
function simplifyCFG(cfg: CFGResult): CFGResult {
  const nodes = [...cfg.nodes];
  const edges = [...cfg.edges];
  const removedIds = new Set<number>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.kind !== 'statement' || removedIds.has(node.id)) continue;

    // Check if this statement has exactly one outgoing edge to another statement
    const outEdges = edges.filter((e) => e.from === node.id && !removedIds.has(e.to));
    if (outEdges.length !== 1) continue;

    const target = nodes.find((n) => n.id === outEdges[0].to);
    if (!target || target.kind !== 'statement') continue;

    // Check target has exactly one incoming edge (from this node)
    const inEdges = edges.filter((e) => e.to === target.id && !removedIds.has(e.from));
    if (inEdges.length !== 1) continue;

    // Merge: keep node, remove target, redirect target's outgoing edges
    removedIds.add(target.id);
    node.code_snippet = `${node.code_snippet} ... (${target.line - node.line + 1} lines)`;

    // Redirect edges
    for (const e of edges) {
      if (e.from === target.id) e.from = node.id;
    }
    // Remove the edge between them
    const idx = edges.findIndex((e) => e.from === node.id && e.to === target.id);
    if (idx !== -1) edges.splice(idx, 1);
  }

  return {
    nodes: nodes.filter((n) => !removedIds.has(n.id)),
    edges: edges.filter((e) => !removedIds.has(e.from) && !removedIds.has(e.to)),
    cyclomatic_complexity: cfg.cyclomatic_complexity,
    paths: cfg.paths,
    max_nesting: cfg.max_nesting,
  };
}
