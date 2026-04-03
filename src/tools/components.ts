import type { Store, ComponentRow } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';

export interface ComponentTreeNode {
  name: string;
  path: string;
  props?: string[];
  emits?: string[];
  slots?: string[];
  composables?: string[];
  children: ComponentTreeNode[];
}

export interface ComponentTreeResult {
  root: ComponentTreeNode;
  totalComponents: number;
}

/**
 * Build a component tree starting from a given file path.
 *
 * Resolves child components via renders_component edges in the graph,
 * recursing up to `depth` levels.
 */
export function getComponentTree(
  store: Store,
  componentPath: string,
  depth = 3,
): TraceMcpResult<ComponentTreeResult> {
  const file = store.getFile(componentPath);
  if (!file) {
    return err(notFound(componentPath));
  }

  const component = store.getComponentByFileId(file.id);
  if (!component) {
    return err(notFound(componentPath, ['File exists but has no component entry']));
  }

  const visited = new Set<string>();
  const root = buildNode(store, component, file.path, depth, visited);

  return ok({
    root,
    totalComponents: visited.size,
  });
}

function buildNode(
  store: Store,
  comp: ComponentRow,
  filePath: string,
  remainingDepth: number,
  visited: Set<string>,
): ComponentTreeNode {
  visited.add(filePath);

  const node: ComponentTreeNode = {
    name: comp.name,
    path: filePath,
    children: [],
  };

  // Parse stored JSON fields
  if (comp.props) {
    const parsed = JSON.parse(comp.props) as Record<string, unknown>;
    node.props = Object.keys(parsed);
  }
  if (comp.emits) {
    node.emits = JSON.parse(comp.emits) as string[];
  }
  if (comp.slots) {
    node.slots = JSON.parse(comp.slots) as string[];
  }
  if (comp.composables) {
    node.composables = JSON.parse(comp.composables) as string[];
  }

  if (remainingDepth <= 0) return node;

  // Find child components via renders_component edges
  const symbols = store.getSymbolsByFile(
    store.getFile(filePath)?.id ?? -1,
  );
  const classSymbol = symbols.find((s) => s.kind === 'class');
  if (!classSymbol) return node;

  const symbolNodeId = store.getNodeId('symbol', classSymbol.id);
  if (symbolNodeId == null) return node;

  const outEdges = store.getOutgoingEdges(symbolNodeId);
  const renderEdges = outEdges.filter((e) => e.edge_type_name === 'renders_component');

  for (const edge of renderEdges) {
    const targetRef = store.getNodeByNodeId(edge.target_node_id);
    if (!targetRef || targetRef.node_type !== 'symbol') continue;

    const targetSymbol = store.getSymbolById(targetRef.ref_id);
    if (!targetSymbol) continue;

    const targetFile = store.getFileById(targetSymbol.file_id);
    if (!targetFile || visited.has(targetFile.path)) continue;

    const targetComp = store.getComponentByFileId(targetFile.id);
    if (!targetComp) continue;

    const childNode = buildNode(store, targetComp, targetFile.path, remainingDepth - 1, visited);
    node.children.push(childNode);
  }

  return node;
}
