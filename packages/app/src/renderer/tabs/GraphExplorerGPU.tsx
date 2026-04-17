import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Graph } from '@cosmos.gl/graph';

const BASE = 'http://127.0.0.1:3741';

export interface GraphExplorerGPUHandle {
  focusNode: (id: string) => void;
}

export interface GraphGPUSettings {
  scope: string;
  granularity: 'file' | 'symbol';
  hideIsolated: boolean;
  symbolKinds: string;
  maxNodes: string;
  colorBy: 'community' | 'language' | 'framework_role';
  showLabels: boolean;
  showFPS: boolean;
  /** How many hops of neighbors to highlight when clicking a node (1–10). */
  highlightDepth: number;
}

export const DEFAULT_GRAPH_GPU_SETTINGS: GraphGPUSettings = {
  scope: 'project',
  granularity: 'file',
  hideIsolated: true,
  symbolKinds: '',
  maxNodes: '',
  colorBy: 'community',
  showLabels: true,
  showFPS: false,
  highlightDepth: 2,
};

interface Props {
  root: string;
  settings: GraphGPUSettings;
  onSettingsChange: (patch: Partial<GraphGPUSettings>) => void;
}

interface VizNode {
  id: string;
  label: string;
  type: 'file' | 'symbol';
  language: string | null;
  framework_role: string | null;
  community: number;
  importance: number;
  repo?: string;
}
interface VizEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
}
interface VizCommunity { id: number; label: string; color: string; }
interface GraphPayload { nodes: VizNode[]; edges: VizEdge[]; communities: VizCommunity[]; }

// ── Theme helpers ─────────────────────────────────────────────────────────
interface Theme {
  background: string;
  linkColor: [number, number, number, number]; // RGBA 0-255 / alpha 0-1
  pointDefaultColor: [number, number, number, number];
  hoveredLink: [number, number, number, number];
}
const THEME_DARK: Theme = {
  background: '#0f1115',
  linkColor: [200, 205, 220, 0.45],
  pointDefaultColor: [160, 165, 180, 1],
  hoveredLink: [255, 255, 255, 0.95],
};
const THEME_LIGHT: Theme = {
  background: '#fafafa',
  linkColor: [60, 65, 80, 0.35],
  pointDefaultColor: [80, 90, 110, 1],
  hoveredLink: [0, 0, 0, 0.9],
};

function detectTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// ── Color palettes ────────────────────────────────────────────────────────
// NOTE: cosmos.gl has an asymmetric color API:
//  * Config tuples (`pointDefaultColor`, `linkDefaultColor`): pass 0–255 RGB, 0–1 alpha
//    — cosmos.gl normalizes them internally via its color parser.
//  * `setPointColors(Float32Array)` / `setLinkColors(Float32Array)`: pass **normalized 0–1 RGB + 0–1 alpha**.
//    These arrays go directly to the GPU buffer unchanged. Passing 0–255 silently clamps to white.
function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function hexToRgb255(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const LANG_COLORS: Record<string, string> = {
  typescript: '#3178c6', javascript: '#f7df1e', tsx: '#3178c6', jsx: '#f7df1e',
  vue: '#41b883', svelte: '#ff3e00',
  php: '#787cb5', python: '#3776ab', go: '#00add8', rust: '#ce412b',
  java: '#ed8b00', kotlin: '#7f52ff', ruby: '#cc342d',
  html: '#e34f26', css: '#1572b6',
  json: '#cbcb41', yaml: '#cb171e', blade: '#f05340',
};
const FRAMEWORK_PALETTE = [
  '#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#7209b7',
  '#f78c6b', '#00b4d8', '#9381ff', '#e76f51', '#2a9d8f',
];

/** Returns normalized (0–1) RGB for a node's current color mode — for Float32Array buffers. */
function nodeColor01(node: VizNode, mode: GraphGPUSettings['colorBy'], commColors: Map<number, string>): [number, number, number] {
  if (mode === 'language') {
    return hexToRgb01(LANG_COLORS[node.language ?? ''] ?? '#888888');
  }
  if (mode === 'framework_role') {
    const role = node.framework_role ?? 'none';
    const h = Array.from(role).reduce((a, c) => a + c.charCodeAt(0), 0) % FRAMEWORK_PALETTE.length;
    return hexToRgb01(FRAMEWORK_PALETTE[h]);
  }
  const c = commColors.get(node.community) ?? '#4e79a7';
  return hexToRgb01(c);
}

function nodeSize(node: VizNode): number {
  const imp = Math.max(0, Math.min(1, node.importance ?? 0));
  return 3 + imp * 12;
}

// Small debounce hook — defers a value update until `delay` ms of no changes.
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// Extract the readable label from a symbol id like `foo/bar.ts::MyClass#class`
function shortLabel(node: VizNode): string {
  const raw = node.label || node.id;
  // For symbol IDs: prefer the last segment after `::`
  if (raw.includes('::')) return raw.split('::').pop() ?? raw;
  // For file paths: last path segment
  const lastSlash = raw.lastIndexOf('/');
  return lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
}

// Best-effort workspace/group inference for a node. Uses the server-provided
// `repo` field when present, else derives from the first 1–2 path segments.
function inferWorkspace(node: VizNode): string {
  if (node.repo) return node.repo;
  const id = node.id.split('::')[0]; // strip symbol suffix
  const parts = id.split('/');
  if (parts.length >= 2) {
    // Take first two dir segments if the second one looks like a dir (no dot).
    if (!parts[1].includes('.')) return `${parts[0]}/${parts[1]}`;
    return parts[0];
  }
  return parts[0] ?? '(root)';
}

export const GraphExplorerGPU = forwardRef<GraphExplorerGPUHandle, Props>(function GraphExplorerGPU(
  { root, settings, onSettingsChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const nodesRef = useRef<VizNode[]>([]);
  const payloadRef = useRef<GraphPayload | null>(null);
  const indexByIdRef = useRef<Map<string, number>>(new Map());
  const labelIndicesRef = useRef<number[]>([]); // which point indices currently carry labels
  const rafLabelRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ nodes: number; edges: number; communities: number } | null>(null);
  const [hovered, setHovered] = useState<VizNode | null>(null);
  const [selected, setSelected] = useState<VizNode | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(detectTheme());
  const [searchQuery, setSearchQuery] = useState('');
  const [live, setLive] = useState(true);           // Live = simulation running + breathing
  const [simRunning, setSimRunning] = useState(true); // polled from cosmos.gl
  const breathTimerRef = useRef<number | null>(null);

  const { scope, granularity, hideIsolated, symbolKinds, maxNodes, colorBy, showLabels, showFPS, highlightDepth } = settings;
  const highlightDepthRef = useRef(highlightDepth);
  highlightDepthRef.current = highlightDepth;

  // Debounce text-input–driven refetches (symbolKinds, maxNodes) so typing
  // doesn't spam /api/projects/graph on every keystroke.
  const debouncedSymbolKinds = useDebounced(symbolKinds, 400);
  const debouncedMaxNodes = useDebounced(maxNodes, 400);

  const themeSpec = theme === 'dark' ? THEME_DARK : THEME_LIGHT;

  // ── Theme watcher ─────────────────────────────────────────────
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // ── focusNode (for imperative handle) ─────────────────────────
  const focusNode = useCallback((id: string) => {
    const graph = graphRef.current;
    const idx = indexByIdRef.current.get(id);
    if (!graph || idx == null) return;
    graph.fitViewByPointIndices([idx], 500, 80);
    const node = nodesRef.current[idx];
    if (node) setSelected(node);
    // Also apply neighborhood highlight
    highlightNeighborhood([idx]);
  }, []);
  useImperativeHandle(ref, () => ({ focusNode }), [focusNode]);

  // ── BFS-expand a seed set to N hops, then tell cosmos.gl to select them ──
  // When any points are "selected", cosmos.gl auto-greys everything else via
  // linkGreyoutOpacity / pointGreyoutColor, giving us the highlight effect.
  const highlightNeighborhood = useCallback((seeds: number[]) => {
    const graph = graphRef.current;
    if (!graph || seeds.length === 0) return;
    const depth = Math.max(1, Math.min(10, highlightDepthRef.current));
    const visited = new Set<number>(seeds);
    let frontier = [...seeds];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: number[] = [];
      for (const idx of frontier) {
        const adj = graph.getAdjacentIndices(idx);
        if (!adj) continue;
        for (const n of adj) {
          if (!visited.has(n)) { visited.add(n); next.push(n); }
        }
      }
      frontier = next;
    }
    graph.selectPointsByIndices(Array.from(visited));
  }, []);

  const clearHighlight = useCallback(() => {
    graphRef.current?.unselectPoints();
    setSelected(null);
  }, []);

  // ── Label overlay rendering ───────────────────────────────────
  // Updates HTML label positions every animation frame based on point screen positions.
  const updateLabels = useCallback(() => {
    const graph = graphRef.current;
    const layer = labelLayerRef.current;
    const nodes = nodesRef.current;
    if (!graph || !layer) return;

    const zoom = graph.getZoomLevel();
    // Which indices to label: always hovered + selected + top-N importance if zoomed in,
    // plus "top-N importance globally" regardless of zoom (to orient the user).
    const indices = new Set<number>();
    if (hovered) {
      const i = indexByIdRef.current.get(hovered.id);
      if (i != null) indices.add(i);
    }
    if (selected) {
      const i = indexByIdRef.current.get(selected.id);
      if (i != null) indices.add(i);
    }
    if (showLabels) {
      // Global top-N (by importance) — keep few when zoomed out, more when zoomed in
      const cap = zoom > 3 ? 60 : zoom > 1.5 ? 20 : 10;
      for (const idx of labelIndicesRef.current.slice(0, cap)) indices.add(idx);
    }

    // Reuse pool of label elements
    const wanted = Array.from(indices);
    let pool = layer.children as HTMLCollectionOf<HTMLDivElement>;
    while (pool.length < wanted.length) {
      const div = document.createElement('div');
      div.className = 'cosmos-gpu-label';
      layer.appendChild(div);
    }
    while (pool.length > wanted.length) {
      layer.removeChild(pool[pool.length - 1]);
    }
    pool = layer.children as HTMLCollectionOf<HTMLDivElement>;

    for (let i = 0; i < wanted.length; i++) {
      const idx = wanted[i];
      const node = nodes[idx];
      if (!node) continue;
      // Get current point position via the graph API
      const positions = graph.getPointPositions(); // flat [x,y,x,y,...] array
      const sx = positions[idx * 2];
      const sy = positions[idx * 2 + 1];
      if (!Number.isFinite(sx)) continue;
      const screen = graph.spaceToScreenPosition([sx, sy]);
      const el = pool[i];
      el.textContent = shortLabel(node);
      el.style.transform = `translate(${screen[0]}px, ${screen[1]}px)`;
      // Highlight hovered/selected
      el.dataset.state = hovered?.id === node.id || selected?.id === node.id ? 'active' : 'normal';
    }
  }, [hovered, selected, showLabels]);

  // Keep labels updated via RAF loop (cheap — just reads positions)
  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      updateLabels();
      rafLabelRef.current = requestAnimationFrame(tick);
    };
    rafLabelRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      if (rafLabelRef.current != null) cancelAnimationFrame(rafLabelRef.current);
    };
  }, [updateLabels]);

  // ── Fetch + render ────────────────────────────────────────────
  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      project: root,
      scope,
      granularity,
      hideIsolated: String(hideIsolated),
      depth: '2',
      layout: 'force',
    });
    if (debouncedSymbolKinds.trim()) params.set('symbolKinds', debouncedSymbolKinds.trim());
    if (debouncedMaxNodes.trim()) params.set(granularity === 'symbol' ? 'maxNodes' : 'maxFiles', debouncedMaxNodes.trim());

    try {
      const resp = await fetch(`${BASE}/api/projects/graph?${params}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error ?? `Server error (${resp.status})`);
      }
      const data = (await resp.json()) as GraphPayload;
      payloadRef.current = data;
      renderGraph(data);
      setStats({ nodes: data.nodes.length, edges: data.edges.length, communities: data.communities.length });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [root, scope, granularity, hideIsolated, debouncedSymbolKinds, debouncedMaxNodes]);

  // Render (or re-render) the graph from a payload. Reuses existing Graph instance.
  const renderGraph = useCallback((data: GraphPayload) => {
    const container = containerRef.current;
    if (!container) return;

    let graph = graphRef.current;
    if (!graph) {
      graph = new Graph(container, {
        backgroundColor: themeSpec.background,
        pointDefaultColor: themeSpec.pointDefaultColor,
        linkDefaultColor: themeSpec.linkColor,
        hoveredLinkColor: themeSpec.hoveredLink,
        pointSize: 6,
        linkWidth: 0.9,
        linkArrows: true,
        linkArrowsSizeScale: 0.6,
        linkVisibilityDistanceRange: [50, 150],
        renderHoveredPointRing: true,
        hoveredPointRingColor: themeSpec.hoveredLink,
        // Greyout — applied automatically when any points are selected.
        pointGreyoutOpacity: 0.08,
        linkGreyoutOpacity: 0.05,
        // Simulation tuning — goal: settle in ~2s, stay centered, no drift.
        // High gravity + centering force keeps the cloud anchored so the user's
        // viewport doesn't suddenly become empty after a breathing tick.
        simulationRepulsion: 0.6,
        simulationLinkSpring: 1.0,
        simulationLinkDistance: 6,
        simulationGravity: 0.6,        // ↑ strong pull to center
        simulationCenter: 0.15,        // ↑ active recentring during ticks
        simulationFriction: 0.93,
        simulationDecay: 300,
        fitViewOnInit: true,
        fitViewPadding: 0.15,
        showFPSMonitor: showFPS,
        hoveredPointCursor: 'pointer',
        onClick: (index: number | undefined) => {
          if (index == null) {
            // Click on empty space — clear everything
            clearHighlight();
            return;
          }
          const node = nodesRef.current[index];
          if (node) setSelected(node);
          highlightNeighborhood([index]);
        },
        onPointMouseOver: (index: number) => {
          const node = nodesRef.current[index];
          if (node) setHovered(node);
        },
        onPointMouseOut: () => setHovered(null),
      });
      graphRef.current = graph;
    }

    // Build indexes
    const nodes = data.nodes;
    nodesRef.current = nodes;
    const indexById = new Map<string, number>();
    nodes.forEach((n, i) => indexById.set(n.id, i));
    indexByIdRef.current = indexById;

    const commColors = new Map<number, string>();
    for (const c of data.communities) commColors.set(c.id, c.color);

    // Positions (random init)
    const positions = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      positions[i * 2] = (Math.random() - 0.5) * 400;
      positions[i * 2 + 1] = (Math.random() - 0.5) * 400;
    }

    // Colors (RGB 0-255, alpha 0-1 — per cosmos.gl convention)
    const colors = new Float32Array(nodes.length * 4);
    for (let i = 0; i < nodes.length; i++) {
      const [r, g, b] = nodeColor01(nodes[i], colorBy, commColors);
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = 1;
    }

    // Sizes
    const sizes = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) sizes[i] = nodeSize(nodes[i]);

    // Links
    const validEdges = data.edges.filter((e) => indexById.has(e.source) && indexById.has(e.target));
    const links = new Float32Array(validEdges.length * 2);
    for (let i = 0; i < validEdges.length; i++) {
      links[i * 2] = indexById.get(validEdges[i].source)!;
      links[i * 2 + 1] = indexById.get(validEdges[i].target)!;
    }

    // Top-N important nodes for label overlay defaults
    const topByImp = [...nodes.keys()].sort(
      (a, b) => (nodes[b].importance ?? 0) - (nodes[a].importance ?? 0),
    );
    labelIndicesRef.current = topByImp.slice(0, 60);

    graph.setPointPositions(positions);
    graph.setPointColors(colors);
    graph.setPointSizes(sizes);
    graph.setLinks(links);
    graph.render();
    // Lower alpha = less initial kinetic energy, shorter settle time.
    // 0.5 is enough for random-init positions to spread meaningfully.
    graph.start(0.5);
  }, [themeSpec, colorBy, showFPS]);

  // ── Initial load & refetch when query params change ───────────
  useEffect(() => { loadGraph(); }, [loadGraph]);

  // ── Recolor WITHOUT refetch when colorBy changes ──────────────
  useEffect(() => {
    const graph = graphRef.current;
    const data = payloadRef.current;
    if (!graph || !data) return;
    const commColors = new Map<number, string>();
    for (const c of data.communities) commColors.set(c.id, c.color);
    const colors = new Float32Array(data.nodes.length * 4);
    for (let i = 0; i < data.nodes.length; i++) {
      const [r, g, b] = nodeColor01(data.nodes[i], colorBy, commColors);
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = 1;
    }
    graph.setPointColors(colors);
    graph.render();
  }, [colorBy]);

  // ── Theme change → update config live ─────────────────────────
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.setConfig({
      backgroundColor: themeSpec.background,
      linkDefaultColor: themeSpec.linkColor,
      pointDefaultColor: themeSpec.pointDefaultColor,
      hoveredLinkColor: themeSpec.hoveredLink,
      hoveredPointRingColor: themeSpec.hoveredLink,
    });
    graph.render();
  }, [themeSpec]);

  // ── FPS toggle ────────────────────────────────────────────────
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.setConfig({ showFPSMonitor: showFPS });
  }, [showFPS]);

  // ── Live mode: keep the graph "breathing" ─────────────────────
  // When Live is on, inject a tiny alpha kick whenever the simulation
  // would otherwise settle. This makes the graph feel like a living
  // organism instead of a dead snapshot. When off, pause the simulation.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    if (breathTimerRef.current != null) {
      clearInterval(breathTimerRef.current);
      breathTimerRef.current = null;
    }

    if (live) {
      graph.unpause();
      // Gentle "breathing" — tiny alpha kick every 2s only when fully settled.
      // High gravity + small alpha means nodes jitter in place without drifting
      // away from the center of the viewport.
      const tick = () => {
        const g = graphRef.current;
        if (!g) return;
        if (!g.isSimulationRunning) g.start(0.02);
        setSimRunning(g.isSimulationRunning);
      };
      breathTimerRef.current = window.setInterval(tick, 2000);
    } else {
      graph.pause();
      setSimRunning(false);
    }

    return () => {
      if (breathTimerRef.current != null) {
        clearInterval(breathTimerRef.current);
        breathTimerRef.current = null;
      }
    };
  }, [live, stats]); // re-attach when a new graph is rendered

  // ── Cleanup on unmount ────────────────────────────────────────
  useEffect(() => {
    return () => {
      try {
        graphRef.current?.destroy?.();
      } catch { /* ignore */ }
      graphRef.current = null;
    };
  }, []);

  // ── Search: collect ALL matches; cap preview list at 8 ───────
  const { searchMatches, searchTotal } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || q.length < 2) return { searchMatches: [] as VizNode[], searchTotal: 0 };
    const hits: VizNode[] = [];
    let total = 0;
    for (const n of nodesRef.current) {
      if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) {
        total++;
        if (hits.length < 8) hits.push(n);
      }
    }
    return { searchMatches: hits, searchTotal: total };
  }, [searchQuery, stats]);

  const doFocus = (node: VizNode) => {
    focusNode(node.id);
    setSearchQuery('');
  };

  // Select all nodes matching the current search query.
  // Intentionally does NOT auto-zoom — for large groups that would fling
  // the view way out. User can hit Fit explicitly if they want.
  const doSelectAllMatches = useCallback(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return;
    const indices: number[] = [];
    for (let i = 0; i < nodesRef.current.length; i++) {
      const n = nodesRef.current[i];
      if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) indices.push(i);
    }
    if (indices.length === 0) return;
    const graph = graphRef.current;
    if (!graph) return;
    const visited = new Set<number>(indices);
    const depth = Math.max(1, Math.min(10, highlightDepthRef.current));
    let frontier = [...indices];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: number[] = [];
      for (const idx of frontier) {
        const adj = graph.getAdjacentIndices(idx);
        if (!adj) continue;
        for (const n of adj) {
          if (!visited.has(n)) { visited.add(n); next.push(n); }
        }
      }
      frontier = next;
    }
    graph.selectPointsByIndices(Array.from(visited));
    setSearchQuery('');
  }, [searchQuery]);

  // ── Workspace/group list (for "highlight group" dropdown) ────
  const workspaceList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodesRef.current) {
      const ws = inferWorkspace(n);
      counts.set(ws, (counts.get(ws) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [stats]);

  // Highlight all nodes in a workspace. Intentionally does NOT auto-zoom —
  // the user wants the view to stay centered where it is unless they explicitly
  // hit Fit or focus a specific node.
  const doHighlightWorkspace = useCallback((ws: string) => {
    const indices: number[] = [];
    for (let i = 0; i < nodesRef.current.length; i++) {
      if (inferWorkspace(nodesRef.current[i]) === ws) indices.push(i);
    }
    if (indices.length === 0) return;
    const graph = graphRef.current;
    if (!graph) return;
    graph.selectPointsByIndices(indices);
  }, []);

  // ── Fit + pause Live (user-requested) ─────────────────────────
  const doFit = useCallback(() => {
    setLive(false);
    const g = graphRef.current;
    if (!g) return;
    g.pause();
    g.fitView(500, 0.15);
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in an input/textarea (except Esc)
      const target = e.target as HTMLElement | null;
      const isInput =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === 'Escape') {
        if (searchQuery) { setSearchQuery(''); (target as HTMLInputElement | null)?.blur?.(); return; }
        clearHighlight();
        return;
      }
      if (isInput) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); doFit(); }
      else if (e.key === ' ') { e.preventDefault(); setLive((v) => !v); }
      else if (e.key === '/') { e.preventDefault(); searchInputRef.current?.focus(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [doFit, clearHighlight, searchQuery]);

  // ── Render ────────────────────────────────────────────────────
  const isDark = theme === 'dark';

  // Native macOS color tokens — matches app.css CSS-vars where possible.
  const sysFont =
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';

  // The CARD — the graph surface itself (dark canvas + border + shadow).
  // Background matches the whole-app surface: slightly different from sidebar,
  // with a 0.5px border-shadow (the signature macOS look).
  const cardStyle: React.CSSProperties = {
    background: isDark ? '#141518' : '#f5f5f7',
    borderRadius: 10,
    boxShadow: isDark
      ? '0 0 0 0.5px rgba(255,255,255,0.08), 0 1px 3px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.18)'
      : '0 0 0 0.5px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.08)',
  };

  // GLASS PILL — floating vibrancy panel used by toolbar + overlays.
  const glassStyle: React.CSSProperties = {
    background: isDark ? 'rgba(30,30,32,0.7)' : 'rgba(255,255,255,0.78)',
    color: isDark ? '#e4e4ea' : '#1d1d1f',
    backdropFilter: 'saturate(180%) blur(20px)',
    WebkitBackdropFilter: 'saturate(180%) blur(20px)',
    boxShadow: isDark
      ? '0 0 0 0.5px rgba(255,255,255,0.12), 0 6px 20px rgba(0,0,0,0.35)'
      : '0 0 0 0.5px rgba(0,0,0,0.1), 0 6px 20px rgba(0,0,0,0.12)',
  };
  const pillStyle: React.CSSProperties = { ...glassStyle, borderRadius: 12 };

  const inputBase =
    'px-2.5 py-1 text-[11px] rounded-md bg-transparent focus:outline-none focus:ring-2 focus:ring-blue-500/50 placeholder:opacity-60';
  const inputStyle: React.CSSProperties = {
    color: isDark ? '#e4e4ea' : '#1d1d1f',
    border: `0.5px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}`,
    fontFamily: sysFont,
  };

  return (
    // Root CARD: rounded, bordered, filling the available pane.
    // Parent (App.tsx `main`) gives us 8px padding so we live as a proper panel
    // alongside the sidebar — NO bleeding into sidebar zone.
    <div
      className="relative w-full h-full overflow-hidden"
      style={{ ...cardStyle, fontFamily: sysFont }}
    >
      {/* WebGL canvas — the graph surface */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Label overlay — HTML over canvas, clipped by root's overflow-hidden */}
      <div
        ref={labelLayerRef}
        className="absolute inset-0 pointer-events-none overflow-hidden"
        style={{
          color: isDark ? '#e4e4ea' : '#1d1d1f',
          fontSize: 10,
          fontFamily: sysFont,
          lineHeight: 1,
        }}
      />

      <style>{`
        .cosmos-gpu-label {
          position: absolute;
          transform: translate(-50%, -50%);
          padding: 1px 5px;
          border-radius: 4px;
          background: ${isDark ? 'rgba(15,17,21,0.55)' : 'rgba(255,255,255,0.78)'};
          white-space: nowrap;
          font-weight: 500;
          pointer-events: none;
          text-shadow: 0 1px 2px ${isDark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)'};
          letter-spacing: -0.01em;
        }
        .cosmos-gpu-label[data-state="active"] {
          background: ${isDark ? '#e4e4ea' : '#0f1115'};
          color: ${isDark ? '#0f1115' : '#e4e4ea'};
          font-weight: 600;
          z-index: 10;
          padding: 2px 6px;
        }
        .cosmos-gpu-pill-btn {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 4px 9px;
          font-size: 11px;
          font-weight: 500;
          border-radius: 6px;
          background: transparent;
          border: 0.5px solid transparent;
          cursor: pointer;
          transition: background-color 120ms, border-color 120ms;
          color: inherit;
          letter-spacing: -0.01em;
          white-space: nowrap;
        }
        .cosmos-gpu-pill-btn:hover {
          background: ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'};
        }
        .cosmos-gpu-pill-btn.active {
          background: ${isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)'};
          border-color: ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'};
        }
        .cosmos-gpu-seg {
          display: inline-flex; gap: 1px;
          padding: 1px;
          border-radius: 7px;
          background: ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'};
        }
        .cosmos-gpu-seg .cosmos-gpu-pill-btn {
          padding: 3px 9px;
          border-radius: 5px;
        }
        .cosmos-gpu-live-dot {
          display: inline-block; width: 7px; height: 7px; border-radius: 999px;
          box-shadow: 0 0 8px currentColor;
        }
        .cosmos-gpu-divider {
          width: 0.5px; height: 16px;
          background: ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'};
          margin: 0 2px;
        }
        .cosmos-gpu-kbd {
          display: inline-flex; align-items: center;
          padding: 1px 5px;
          font-family: "SF Mono", Menlo, Monaco, monospace;
          font-size: 10px;
          background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};
          border: 0.5px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
          border-radius: 3px;
          opacity: 0.55;
        }
      `}</style>

      {/* ── Floating toolbar — constrained to card width, wraps if needed ── */}
      <div
        className="absolute top-2.5 z-30 flex items-center gap-1 px-2 py-1.5"
        style={{
          ...pillStyle,
          // Anchor at fixed margins from the card edges instead of left:50%:
          // centering is handled by flex + max-width, so the pill can never
          // extend beyond its pane (no overlap with sidebar).
          left: '50%',
          transform: 'translateX(-50%)',
          maxWidth: 'calc(100% - 24px)',
          flexWrap: 'wrap',
          justifyContent: 'center',
          rowGap: 4,
        }}
      >
        {/* Granularity toggle — segmented */}
        <div className="cosmos-gpu-seg">
          <button
            onClick={() => onSettingsChange({ granularity: 'file' })}
            className={`cosmos-gpu-pill-btn ${granularity === 'file' ? 'active' : ''}`}
          >
            Files
          </button>
          <button
            onClick={() => onSettingsChange({ granularity: 'symbol' })}
            className={`cosmos-gpu-pill-btn ${granularity === 'symbol' ? 'active' : ''}`}
          >
            Symbols
          </button>
        </div>

        <div className="w-px h-4 mx-0.5" style={{ background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }} />

        {/* Color dropdown */}
        <select
          value={colorBy}
          onChange={(e) => onSettingsChange({ colorBy: e.target.value as GraphGPUSettings['colorBy'] })}
          className={inputBase}
          style={{ ...inputStyle, border: 'none' }}
        >
          <option value="community">Community</option>
          <option value="language">Language</option>
          <option value="framework_role">Framework</option>
        </select>

        {/* Toggle buttons — checkboxes replaced with tappable pills */}
        <button
          onClick={() => onSettingsChange({ hideIsolated: !hideIsolated })}
          className={`cosmos-gpu-pill-btn ${hideIsolated ? 'active' : ''}`}
          title="Hide nodes with no edges"
        >
          ⌀ Isolated
        </button>
        <button
          onClick={() => onSettingsChange({ showLabels: !showLabels })}
          className={`cosmos-gpu-pill-btn ${showLabels ? 'active' : ''}`}
          title="Show top labels"
        >
          Labels
        </button>
        <button
          onClick={() => onSettingsChange({ showFPS: !showFPS })}
          className={`cosmos-gpu-pill-btn ${showFPS ? 'active' : ''}`}
          title="Show FPS counter"
        >
          FPS
        </button>

        <div className="w-px h-4 mx-0.5" style={{ background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }} />

        {/* Search (typeahead) — also supports "Select all N". Press `/` to focus. */}
        <div className="relative">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search  /"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doSelectAllMatches(); }}
            className={`${inputBase} w-40`}
            style={inputStyle}
          />
          {searchMatches.length > 0 && (
            <ul
              className="absolute z-40 mt-1.5 w-80 max-h-80 overflow-y-auto"
              style={{ ...pillStyle, borderRadius: 12, padding: 4 }}
            >
              {searchTotal > 1 && (
                <li
                  onClick={doSelectAllMatches}
                  className="px-2.5 py-1.5 mb-1 rounded-md cursor-pointer hover:bg-blue-500/20 text-[11px] font-semibold"
                  style={{ color: '#60a5fa' }}
                >
                  ✨ Select all {searchTotal} matches
                </li>
              )}
              {searchMatches.map((n) => (
                <li
                  key={n.id}
                  onClick={() => doFocus(n)}
                  className="px-2.5 py-1.5 rounded-md cursor-pointer hover:bg-white/10 dark:hover:bg-white/10 font-mono text-[11px] break-all"
                >
                  <div>{shortLabel(n)}</div>
                  <div style={{ opacity: 0.55 }} className="text-[10px] truncate">{n.id}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Workspace / group highlight dropdown */}
        {workspaceList.length > 1 && (
          <select
            onChange={(e) => {
              if (e.target.value) {
                doHighlightWorkspace(e.target.value);
                e.target.value = '';
              }
            }}
            defaultValue=""
            className={inputBase}
            style={{ ...inputStyle, border: 'none' }}
            title="Highlight all nodes in a workspace/group"
          >
            <option value="">Highlight group…</option>
            {workspaceList.map((w) => (
              <option key={w.name} value={w.name}>{w.name} ({w.count})</option>
            ))}
          </select>
        )}

        <div className="w-px h-4 mx-0.5" style={{ background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }} />

        {/* Highlight depth slider (1–10 hops) */}
        <label
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-md select-none"
          style={inputStyle}
          title="How many hops of neighbors to highlight when clicking a node"
        >
          <span style={{ opacity: 0.7 }}>Depth</span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={highlightDepth}
            onChange={(e) => onSettingsChange({ highlightDepth: Number(e.target.value) })}
            className="w-16"
          />
          <span className="font-mono w-3 text-right">{highlightDepth}</span>
        </label>

        {/* Live / Paused toggle */}
        <button
          onClick={() => setLive((v) => !v)}
          className="cosmos-gpu-pill-btn"
          title={`${live ? 'Pause' : 'Resume'} simulation (Space)`}
        >
          <span
            className="cosmos-gpu-live-dot"
            style={{
              color: live ? (simRunning ? '#34c759' : '#ffcc00') : '#ff3b30',
              background: live ? (simRunning ? '#34c759' : '#ffcc00') : '#ff3b30',
              animation: live && simRunning ? 'cosmos-gpu-pulse 1.6s ease-in-out infinite' : 'none',
            }}
          />
          {live ? 'Live' : 'Paused'}
        </button>

        <button
          onClick={doFit}
          className="cosmos-gpu-pill-btn"
          title="Fit view & pause (F)"
        >
          Fit <span className="cosmos-gpu-kbd">F</span>
        </button>

        <button
          onClick={clearHighlight}
          className="cosmos-gpu-pill-btn"
          title="Clear highlight (Esc)"
        >
          ⌫
        </button>

        <button
          onClick={loadGraph}
          className="cosmos-gpu-pill-btn"
          title="Reload graph data"
        >
          ↻
        </button>
      </div>
      <style>{`
        @keyframes cosmos-gpu-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50%      { transform: scale(1.35); opacity: 0.6; }
        }
      `}</style>

      {/* Stats — bottom-right, minimal */}
      {stats && (
        <div
          className="absolute bottom-3 right-3 z-20 px-3 py-1 text-[10px] font-mono"
          style={{ ...pillStyle, borderRadius: 999, opacity: 0.85 }}
        >
          {stats.nodes.toLocaleString()} · {stats.edges.toLocaleString()} edges · {stats.communities} groups
        </div>
      )}

      {loading && (
        <div
          className="absolute inset-0 flex items-center justify-center text-sm pointer-events-none z-20"
          style={{ color: isDark ? '#fff' : '#000', background: isDark ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.45)' }}
        >
          Building graph…
        </div>
      )}

      {error && (
        <div
          className="absolute top-14 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 text-[11px]"
          style={{ ...pillStyle, background: 'rgba(239,68,68,0.9)', color: '#fff', border: 'none', borderRadius: 999 }}
        >
          {error}
        </div>
      )}

      {/* Hover info (left) */}
      {hovered && !selected && (
        <div
          className="absolute bottom-3 left-3 z-20 px-3 py-2 text-[11px] max-w-md"
          style={{ ...pillStyle, borderRadius: 12 }}
        >
          <div className="font-mono break-all">{hovered.label}</div>
          <div style={{ opacity: 0.6 }} className="text-[10px]">
            {hovered.type} · {hovered.language ?? '—'} · community {hovered.community} · imp {hovered.importance.toFixed(3)}
          </div>
        </div>
      )}

      {/* Selected info (right) */}
      {selected && (
        <div
          className="absolute top-14 right-3 z-20 px-3 py-2 text-[11px] max-w-sm"
          style={{ ...pillStyle, borderRadius: 12 }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono break-all">{selected.label}</div>
              <div style={{ opacity: 0.6 }} className="mt-0.5 text-[10px]">
                {selected.type} · {selected.language ?? '—'} · community {selected.community} · imp {selected.importance.toFixed(3)}
              </div>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="cosmos-gpu-pill-btn"
              style={{ padding: '2px 6px', opacity: 0.7 }}
            >×</button>
          </div>
        </div>
      )}
    </div>
  );
});
