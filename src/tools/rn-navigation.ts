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

  const navEdges = store.getEdgesByType('rn_navigates_to');
  for (const edge of navEdges) {
    const sourceRef = store.getNodeByNodeId(edge.source_node_id);
    const targetRef = store.getNodeByNodeId(edge.target_node_id);
    if (!sourceRef || !targetRef) continue;

    // Find screen names from ref IDs
    const sourceScreen = allScreens.find((s) => {
      const nodeId = store.getNodeId('rn_screen', s.id);
      return nodeId === edge.source_node_id;
    });
    const targetScreen = allScreens.find((s) => {
      const nodeId = store.getNodeId('rn_screen', s.id);
      return nodeId === edge.target_node_id;
    });

    if (sourceScreen && targetScreen) {
      const existing = map.get(sourceScreen.name) ?? [];
      existing.push(targetScreen.name);
      map.set(sourceScreen.name, existing);
    }
  }

  return map;
}
