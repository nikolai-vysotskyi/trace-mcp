/**
 * Class Hierarchy Analysis (CHA) — polymorphic call resolution.
 *
 * Given a method symbol, expands to all "equivalent" methods across the class
 * hierarchy: same-named methods on ancestor/descendant classes linked by
 * extends/implements edges.  This lets find_usages, get_change_impact, and
 * get_call_graph see through polymorphic dispatch.
 *
 * Example: `HubAuthProvider.verify_token` is an override of `OAuthProvider.verify_token`.
 * A call site typed as `OAuthProvider.verify_token` should appear as a reference
 * to HubAuthProvider's override — CHA makes that connection.
 */
import type { Store, SymbolRow } from '../../db/store.js';

// Heritage edge types across languages
const HERITAGE_EDGE_TYPES = [
  'ts_extends',
  'ts_implements', // TypeScript
  'extends',
  'implements', // PHP
  'py_inherits', // Python (fallback)
];

interface ChaMethodMatch {
  /** The symbol row of the matching method */
  symbol: SymbolRow;
  /** Node ID in the unified graph */
  nodeId: number;
  /** Relationship to the queried symbol */
  relation: 'self' | 'ancestor_method' | 'descendant_method';
}

/**
 * Expand a method symbol to all polymorphically-equivalent methods.
 *
 * Given method `C.M`, finds:
 * - `C.M` itself
 * - `A.M` for every ancestor `A` of `C` (base class methods that `C.M` overrides)
 * - `D.M` for every descendant `D` of `C` (subclass methods that override `C.M`)
 *
 * This is the core CHA query used by find_usages, get_change_impact, and get_call_graph.
 */
export function expandMethodViaCha(
  store: Store,
  symbol: SymbolRow,
  maxDepth = 10,
): ChaMethodMatch[] {
  // Only expand methods — functions, classes, etc. don't have polymorphic dispatch
  if (symbol.kind !== 'method') {
    const nodeId = store.getNodeId('symbol', symbol.id);
    if (nodeId == null) return [];
    return [{ symbol, nodeId, relation: 'self' }];
  }

  const methodName = symbol.name;

  // Find the parent class of this method
  const parentClass = symbol.parent_id != null ? store.getSymbolById(symbol.parent_id) : null;

  if (!parentClass || (parentClass.kind !== 'class' && parentClass.kind !== 'interface')) {
    const nodeId = store.getNodeId('symbol', symbol.id);
    if (nodeId == null) return [];
    return [{ symbol, nodeId, relation: 'self' }];
  }

  const results: ChaMethodMatch[] = [];
  const selfNodeId = store.getNodeId('symbol', symbol.id);
  if (selfNodeId != null) {
    results.push({ symbol, nodeId: selfNodeId, relation: 'self' });
  }

  // Collect all related classes (ancestors + descendants)
  const ancestorClassIds = new Set<number>();
  const descendantClassIds = new Set<number>();

  collectAncestors(store, parentClass, ancestorClassIds, new Set(), maxDepth);
  collectDescendants(store, parentClass.name, descendantClassIds, new Set(), maxDepth);

  // Find same-named methods on ancestor classes
  for (const classId of ancestorClassIds) {
    const method = findMethodOnClass(store, classId, methodName);
    if (method && method.id !== symbol.id) {
      const nodeId = store.getNodeId('symbol', method.id);
      if (nodeId != null) {
        results.push({ symbol: method, nodeId, relation: 'ancestor_method' });
      }
    }
  }

  // Find same-named methods on descendant classes
  for (const classId of descendantClassIds) {
    const method = findMethodOnClass(store, classId, methodName);
    if (method && method.id !== symbol.id) {
      const nodeId = store.getNodeId('symbol', method.id);
      if (nodeId != null) {
        results.push({ symbol: method, nodeId, relation: 'descendant_method' });
      }
    }
  }

  return results;
}

/**
 * Get all node IDs that are polymorphically equivalent to the given node.
 * Convenience wrapper around expandMethodViaCha for tools that just need node IDs.
 */
export function getChaNodeIds(store: Store, symbol: SymbolRow): number[] {
  return expandMethodViaCha(store, symbol).map((m) => m.nodeId);
}

/**
 * Walk UP the class hierarchy, collecting ancestor class symbol IDs.
 * Uses both heritage edges in the graph AND metadata.extends/implements.
 */
function collectAncestors(
  store: Store,
  classSymbol: SymbolRow,
  result: Set<number>,
  visited: Set<number>,
  depth: number,
): void {
  if (depth <= 0 || visited.has(classSymbol.id)) return;
  visited.add(classSymbol.id);

  // Strategy 1: Follow heritage edges in the graph (ts_extends, ts_implements, extends, py_inherits)
  const nodeId = store.getNodeId('symbol', classSymbol.id);
  if (nodeId != null) {
    const outgoing = store.getOutgoingEdges(nodeId);
    for (const edge of outgoing) {
      if (!HERITAGE_EDGE_TYPES.includes(edge.edge_type_name)) continue;
      const targetRef = store.getNodeRef(edge.target_node_id);
      if (!targetRef || targetRef.nodeType !== 'symbol') continue;
      result.add(targetRef.refId);
      const parentSym = store.getSymbolById(targetRef.refId);
      if (parentSym) {
        collectAncestors(store, parentSym, result, visited, depth - 1);
      }
    }
  }

  // Strategy 2: Parse metadata.extends/implements (catches cases where edges weren't resolved)
  if (classSymbol.metadata) {
    try {
      const meta = JSON.parse(classSymbol.metadata) as Record<string, unknown>;
      const parentNames: string[] = [];

      const ext = meta.extends;
      if (Array.isArray(ext))
        parentNames.push(...ext.filter((n): n is string => typeof n === 'string'));
      else if (typeof ext === 'string') parentNames.push(ext);

      const impl = meta.implements;
      if (Array.isArray(impl))
        parentNames.push(...impl.filter((n): n is string => typeof n === 'string'));

      // Python bases
      const bases = meta.bases;
      if (Array.isArray(bases))
        parentNames.push(...bases.filter((n): n is string => typeof n === 'string'));

      for (const name of parentNames) {
        const shortName = name.includes('.') ? name.split('.').pop()! : name;
        const parentSym =
          store.getSymbolByName(shortName, 'class') ??
          store.getSymbolByName(shortName, 'interface');
        if (parentSym && !result.has(parentSym.id)) {
          result.add(parentSym.id);
          collectAncestors(store, parentSym, result, visited, depth - 1);
        }
      }
    } catch {
      /* skip malformed metadata */
    }
  }
}

/**
 * Walk DOWN the class hierarchy, collecting descendant class symbol IDs.
 * Uses findImplementors which scans metadata.extends/implements.
 */
function collectDescendants(
  store: Store,
  className: string,
  result: Set<number>,
  visited: Set<string>,
  depth: number,
): void {
  if (depth <= 0 || visited.has(className)) return;
  visited.add(className);

  const implementors = store.findImplementors(className);
  for (const impl of implementors) {
    if (result.has(impl.id)) continue;
    result.add(impl.id);
    collectDescendants(store, impl.name, result, visited, depth - 1);
  }
}

/**
 * Find a method with the given name that is a direct child of the given class.
 */
function findMethodOnClass(store: Store, classId: number, methodName: string): SymbolRow | null {
  const children = store.getSymbolChildren(classId);
  return (
    children.find((s) => s.name === methodName && (s.kind === 'method' || s.kind === 'function')) ??
    null
  );
}
