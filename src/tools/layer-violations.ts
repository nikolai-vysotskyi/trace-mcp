/**
 * Architectural layer enforcement.
 *
 * Layers are declared as { name, path_prefixes, may_not_import[] }.
 * The tool scans the file-level import graph and reports any edge
 * where the source file's layer is forbidden from importing the target file's layer.
 */

import type { Store } from '../db/store.js';
import { buildFileGraph } from './graph-analysis.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface LayerDefinition {
  name: string;
  /** File path prefixes that belong to this layer (e.g. ["src/domain/", "src/entities/"]) */
  path_prefixes: string[];
  /** Layer names this layer may NOT import from */
  may_not_import: string[];
}

export interface LayerViolation {
  source_file: string;
  source_layer: string;
  target_file: string;
  target_layer: string;
  rule: string;
}

interface LayerViolationResult {
  total_violations: number;
  violations: LayerViolation[];
  layers_checked: string[];
}

// ════════════════════════════════════════════════════════════════════════
// BUILT-IN LAYER PRESETS
// ════════════════════════════════════════════════════════════════════════

/** Common layered architecture presets that can be auto-detected. */
const PRESETS: Record<string, LayerDefinition[]> = {
  'clean-architecture': [
    { name: 'domain', path_prefixes: ['src/domain/', 'src/entities/', 'app/Domain/'], may_not_import: ['infrastructure', 'presentation', 'application'] },
    { name: 'application', path_prefixes: ['src/application/', 'src/use-cases/', 'app/Application/', 'src/services/'], may_not_import: ['infrastructure', 'presentation'] },
    { name: 'infrastructure', path_prefixes: ['src/infrastructure/', 'src/infra/', 'app/Infrastructure/'], may_not_import: ['presentation'] },
    { name: 'presentation', path_prefixes: ['src/presentation/', 'src/controllers/', 'src/routes/', 'app/Http/', 'src/pages/'], may_not_import: [] },
  ],
  'hexagonal': [
    { name: 'domain', path_prefixes: ['src/domain/', 'src/core/'], may_not_import: ['adapters', 'ports'] },
    { name: 'ports', path_prefixes: ['src/ports/'], may_not_import: ['adapters'] },
    { name: 'adapters', path_prefixes: ['src/adapters/', 'src/infrastructure/'], may_not_import: [] },
  ],
};

// ════════════════════════════════════════════════════════════════════════
// LAYER RESOLUTION
// ════════════════════════════════════════════════════════════════════════

function resolveLayer(filePath: string, layers: LayerDefinition[]): string | null {
  for (const layer of layers) {
    for (const prefix of layer.path_prefixes) {
      if (filePath.startsWith(prefix)) return layer.name;
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════

export function getLayerViolations(
  store: Store,
  layers: LayerDefinition[],
): LayerViolationResult {
  const graph = buildFileGraph(store);
  const violations: LayerViolation[] = [];

  // Build forbidden rules lookup: layer_name → Set<forbidden_layer_name>
  const forbidden = new Map<string, Set<string>>();
  for (const layer of layers) {
    forbidden.set(layer.name, new Set(layer.may_not_import));
  }

  // Check every import edge
  for (const [srcFileId, targets] of graph.forward) {
    const srcPath = graph.pathMap.get(srcFileId);
    if (!srcPath) continue;
    const srcLayer = resolveLayer(srcPath, layers);
    if (!srcLayer) continue;

    const srcForbidden = forbidden.get(srcLayer);
    if (!srcForbidden || srcForbidden.size === 0) continue;

    for (const tgtFileId of targets) {
      const tgtPath = graph.pathMap.get(tgtFileId);
      if (!tgtPath) continue;
      const tgtLayer = resolveLayer(tgtPath, layers);
      if (!tgtLayer) continue;

      if (srcForbidden.has(tgtLayer)) {
        violations.push({
          source_file: srcPath,
          source_layer: srcLayer,
          target_file: tgtPath,
          target_layer: tgtLayer,
          rule: `${srcLayer} may not import ${tgtLayer}`,
        });
      }
    }
  }

  return {
    total_violations: violations.length,
    violations,
    layers_checked: layers.map((l) => l.name),
  };
}

/**
 * Try to detect which preset matches the project structure.
 * Returns the matching preset layers or null.
 */
export function detectLayerPreset(store: Store): { preset: string; layers: LayerDefinition[] } | null {
  const allFiles = store.getAllFiles();
  const paths = allFiles.map((f) => f.path);

  for (const [presetName, layers] of Object.entries(PRESETS)) {
    let matchCount = 0;
    for (const layer of layers) {
      const hasMatch = layer.path_prefixes.some((prefix) =>
        paths.some((p) => p.startsWith(prefix)),
      );
      if (hasMatch) matchCount++;
    }
    // Need at least 2 layers matched to consider it a valid preset
    if (matchCount >= 2) {
      return { preset: presetName, layers };
    }
  }
  return null;
}

export { PRESETS as LAYER_PRESETS };
