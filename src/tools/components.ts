import type { Store, ComponentRow } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';
import { estimateTokens } from '../utils/token-counter.js';

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
  truncated?: boolean;
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
  tokenBudget = 8000,
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
  const budgetRef = { remaining: tokenBudget, truncated: false };
  const root = buildNode(store, component, file.path, depth, visited, budgetRef);

  return ok({
    root,
    totalComponents: visited.size,
    ...(budgetRef.truncated ? { truncated: true } : {}),
  });
}

function buildNode(
  store: Store,
  comp: ComponentRow,
  filePath: string,
  remainingDepth: number,
  visited: Set<string>,
  budget: { remaining: number; truncated: boolean },
): ComponentTreeNode {
  visited.add(filePath);

  const node: ComponentTreeNode = {
    name: comp.name,
    path: filePath,
    children: [],
  };

  // Parse stored JSON fields (gracefully handle corrupted data)
  try {
    if (comp.props) {
      const parsed = JSON.parse(comp.props) as Record<string, unknown>;
      node.props = Object.keys(parsed);
    }
  } catch { /* corrupted JSON */ }
  try {
    if (comp.emits) node.emits = JSON.parse(comp.emits) as string[];
  } catch { /* corrupted JSON */ }
  try {
    if (comp.slots) node.slots = JSON.parse(comp.slots) as string[];
  } catch { /* corrupted JSON */ }
  try {
    if (comp.composables) node.composables = JSON.parse(comp.composables) as string[];
  } catch { /* corrupted JSON */ }

  budget.remaining -= estimateTokens(JSON.stringify(node));
  if (budget.remaining <= 0 || remainingDepth <= 0) return node;

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
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }

    const targetRef = store.getNodeByNodeId(edge.target_node_id);
    if (!targetRef || targetRef.node_type !== 'symbol') continue;

    const targetSymbol = store.getSymbolById(targetRef.ref_id);
    if (!targetSymbol) continue;

    const targetFile = store.getFileById(targetSymbol.file_id);
    if (!targetFile || visited.has(targetFile.path)) continue;

    const targetComp = store.getComponentByFileId(targetFile.id);
    if (!targetComp) continue;

    const childNode = buildNode(store, targetComp, targetFile.path, remainingDepth - 1, visited, budget);
    node.children.push(childNode);
  }

  return node;
}
