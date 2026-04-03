/**
 * get_navigation_graph — React Native navigation tree.
 *
 * Builds full navigation tree from RN screens + navigators.
 */
import type { Store, RnScreenRow } from '../db/store.js';
import { ok, type TraceMcpResult } from '../errors.js';

export interface NavigationNode {
  screen: string;
  component?: string;
  navigatorType?: string;
  deepLink?: string;
  navigatesTo: string[];
  metadata?: Record<string, unknown>;
}

export interface NavigationGraphResult {
  screens: NavigationNode[];
  navigatorTypes: string[];
  deepLinks: { screen: string; path: string }[];
  totalScreens: number;
}

/**
 * Build navigation graph from all indexed RN screens.
 */
export function getNavigationGraph(
  store: Store,
): TraceMcpResult<NavigationGraphResult> {
  const allScreens = store.getAllRnScreens();

  // Build edges from edges table (rn_navigates_to)
  const navigatesMap = buildNavigatesMap(store, allScreens);

  const screens: NavigationNode[] = allScreens.map((s) => ({
    screen: s.name,
    component: s.component_path ?? undefined,
    navigatorType: s.navigator_type ?? undefined,
    deepLink: s.deep_link ?? undefined,
    navigatesTo: navigatesMap.get(s.name) ?? [],
    metadata: s.metadata ? JSON.parse(s.metadata) : undefined,
  }));

  const navigatorTypes = [
    ...new Set(allScreens.map((s) => s.navigator_type).filter(Boolean) as string[]),
  ];

  const deepLinks = allScreens
    .filter((s) => s.deep_link)
    .map((s) => ({ screen: s.name, path: s.deep_link! }));

  return ok({
    screens,
    navigatorTypes,
    deepLinks,
    totalScreens: allScreens.length,
  });
}

/**
 * Build a map of screen -> screens it navigates to,
 * using rn_navigates_to edges from the graph.
 */
function buildNavigatesMap(
  store: Store,
  allScreens: RnScreenRow[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();

  // Pre-build nodeId → screenName lookup in one batch query (avoids O(edges*screens) N+1)
  const screenIds = allScreens.map((s) => s.id);
  const nodeIdMap = store.getNodeIdsBatch('rn_screen', screenIds);
  const nodeToScreen = new Map<number, string>();
  for (const screen of allScreens) {
    const nodeId = nodeIdMap.get(screen.id);
    if (nodeId !== undefined) nodeToScreen.set(nodeId, screen.name);
  }

  const navEdges = store.getEdgesByType('rn_navigates_to');
  for (const edge of navEdges) {
    const sourceName = nodeToScreen.get(edge.source_node_id);
    const targetName = nodeToScreen.get(edge.target_node_id);

    if (sourceName && targetName) {
      const existing = map.get(sourceName) ?? [];
      existing.push(targetName);
      map.set(sourceName, existing);
    }
  }

  return map;
}
