/**
 * Multi-signal dead code detection (v2).
 *
 * Three independent evidence signals:
 * 1. Import graph — symbol name not found in any import specifier
 * 2. Call graph — symbol name not mentioned in bodies of other files
 * 3. Barrel exports — symbol not re-exported from any barrel file (index.ts, __init__.py, mod.rs)
 *
 * Confidence = signals_fired / 3.  Default threshold 0.5 (at least 2 of 3 must fire).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import { logger } from '../logger.js';

// ════════════════════════════════��═══════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface DeadCodeItem {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  confidence: number;
  signals: {
    import_graph: boolean;
    call_graph: boolean;
    barrel_exports: boolean;
  };
}

export interface DeadCodeResult {
  file_pattern: string | null;
  dead_symbols: DeadCodeItem[];
  total_exports: number;
  total_dead: number;
  threshold: number;
}

// ═══════════════════════════════���════════════════════════════════════════
// BARREL FILE DETECTION
// ═══════════════════════════════════════════��════════════════════════════

const BARREL_PATTERNS = [
  /^index\.[jt]sx?$/,
  /^mod\.rs$/,
  /^__init__\.py$/,
  /^main\.[jt]sx?$/,
];

function isBarrelFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return BARREL_PATTERNS.some((p) => p.test(base));
}

// ════════════════════════════════════════════════════════════════════════
// SIGNAL 1: IMPORT GRAPH
// ═══════════════════════════════════════��════════════════════════════════

/**
 * Build set of all imported specifier names across the project.
 * Uses import edges metadata which stores specifier lists.
 */
function buildImportedNamesSet(store: Store): Set<string> {
  const importedNames = new Set<string>();

  for (const edgeType of ['imports', 'esm_imports', 'py_imports']) {
    const edges = store.getEdgesByType(edgeType);
    for (const edge of edges) {
      if (!edge.metadata) continue;
      const meta = typeof edge.metadata === 'string'
        ? JSON.parse(edge.metadata) as Record<string, unknown>
        : edge.metadata as Record<string, unknown>;

      const specifiers = meta['specifiers'];
      if (Array.isArray(specifiers)) {
        for (const s of specifiers) {
          if (typeof s === 'string') {
            const clean = s.startsWith('* as ') ? s.slice(5) : s;
            importedNames.add(clean);
          }
        }
      }
    }
  }

  return importedNames;
}

// ════════════════════════════════════════════════════════════════════════
// SIGNAL 2: CALL GRAPH (text-match in other files' bodies)
// ════════════════════════════════════════════════════════════════════════

/**
 * Build a set of symbol names that appear in call/reference edges.
 * Checks if the symbol's node has any incoming edges (calls, references).
 */
function buildReferencedSymbolIds(store: Store): Set<number> {
  const referenced = new Set<number>();

  for (const edgeType of ['calls', 'references']) {
    const edges = store.getEdgesByType(edgeType);
    for (const edge of edges) {
      referenced.add(edge.target_node_id);
    }
  }

  return referenced;
}

// ════════════════════════════════════════════════════════════════════════
// SIGNAL 3: BARREL EXPORTS
// ═════════════════════════════════════════════════���══════════════════════

/**
 * Build set of symbol names that are re-exported from barrel files.
 * Scans import edges where the SOURCE file is a barrel file.
 */
function buildBarrelExportedNames(store: Store): Set<string> {
  const barrelNames = new Set<string>();

  const allFiles = store.getAllFiles();
  const barrelFileIds = new Set<number>();
  for (const f of allFiles) {
    if (isBarrelFile(f.path)) barrelFileIds.add(f.id);
  }

  if (barrelFileIds.size === 0) return barrelNames;

  // Get barrel file node IDs (batched)
  const barrelNodeMap = store.getNodeIdsBatch('file', [...barrelFileIds]);
  const barrelNodeIds = new Set<number>(barrelNodeMap.values());

  // Check ESM import edges FROM barrel files — the specifiers they import
  // are effectively re-exported
  for (const edgeType of ['esm_imports', 'imports', 'py_imports', 'py_reexports']) {
    const edges = store.getEdgesByType(edgeType);
    for (const edge of edges) {
      if (!barrelNodeIds.has(edge.source_node_id)) continue;
      if (!edge.metadata) continue;

      const meta = typeof edge.metadata === 'string'
        ? JSON.parse(edge.metadata) as Record<string, unknown>
        : edge.metadata as Record<string, unknown>;

      const specifiers = meta['specifiers'];
      if (Array.isArray(specifiers)) {
        for (const s of specifiers) {
          if (typeof s === 'string') {
            const clean = s.startsWith('* as ') ? s.slice(5) : s;
            barrelNames.add(clean);
          }
        }
      }
    }
  }

  return barrelNames;
}

// ════════════════════════════��═══════════════════════════════════════════
// MAIN: MULTI-SIGNAL DEAD CODE DETECTION
// ════════════════════════════════════════════════════════════════════════

export function getDeadCodeV2(
  store: Store,
  options: {
    filePattern?: string;
    threshold?: number;
    limit?: number;
  } = {},
): DeadCodeResult {
  const { filePattern, threshold = 0.5, limit = 50 } = options;

  // Get all exported symbols, excluding test fixtures (they're sample projects
  // whose exports are never imported — always false positives)
  const TEST_FIXTURE_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/fixtures?\//;
  const exported = store.getExportedSymbols(filePattern)
    .filter((s) => s.kind !== 'method') // methods inherit export from class
    .filter((s) => !TEST_FIXTURE_RE.test(s.file_path));

  // Build all three signal datasets
  const importedNames = buildImportedNamesSet(store);
  const referencedNodeIds = buildReferencedSymbolIds(store);
  const barrelExportedNames = buildBarrelExportedNames(store);

  // Batch: get node IDs for all exported symbols at once
  const exportedSymIds = exported.map((s) => s.id);
  const symNodeIdMap = store.getNodeIdsBatch('symbol', exportedSymIds);

  const dead: DeadCodeItem[] = [];

  for (const sym of exported) {
    // Signal 1: not in any import specifier
    const notImported = !importedNames.has(sym.name);

    // Signal 2: no incoming call/reference edges to this symbol's node
    const symNodeId = symNodeIdMap.get(sym.id);
    const notReferenced = symNodeId === undefined || !referencedNodeIds.has(symNodeId);

    // Signal 3: not re-exported from any barrel file
    const notInBarrel = !barrelExportedNames.has(sym.name);

    const signalCount = (notImported ? 1 : 0) + (notReferenced ? 1 : 0) + (notInBarrel ? 1 : 0);
    const confidence = Math.round((signalCount / 3) * 100) / 100;

    if (confidence >= threshold) {
      dead.push({
        symbol_id: sym.symbol_id,
        name: sym.name,
        kind: sym.kind,
        file: sym.file_path,
        line: sym.line_start,
        confidence,
        signals: {
          import_graph: notImported,
          call_graph: notReferenced,
          barrel_exports: notInBarrel,
        },
      });
    }
  }

  // Sort by confidence desc, then by name
  dead.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

  return {
    file_pattern: filePattern ?? null,
    dead_symbols: dead.slice(0, limit),
    total_exports: exported.length,
    total_dead: dead.length,
    threshold,
  };
}
