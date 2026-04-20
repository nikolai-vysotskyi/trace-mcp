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

// Explicit override on <html data-theme> (set by the sidebar ThemeToggle in
// App.tsx) wins; otherwise fall back to the system preference. Keep this in
// sync with the logic in App.tsx's useTheme().
function detectTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  const override = document.documentElement.getAttribute('data-theme');
  if (override === 'light' || override === 'dark') return override;
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

/**
 * Per-link RGBA tinted as a shade of the source node's color — lerped toward
 * the background so edges read as an atmospheric halo of their source node
 * instead of competing with it. Saturation ceiling in dense clusters is the
 * tint itself, not white → no more pure-white blowout.
 */
function computeTintedLinkColors(
  pointColors: Float32Array,
  linkPairs: Float32Array,
  bgRgb01: [number, number, number],
  mix: number,
  alpha: number,
): Float32Array {
  const numLinks = Math.floor(linkPairs.length / 2);
  const out = new Float32Array(numLinks * 4);
  const [br, bgc, bb] = bgRgb01;
  for (let i = 0; i < numLinks; i++) {
    const si = (linkPairs[i * 2] | 0) * 4;
    out[i * 4]     = br  + (pointColors[si]     - br)  * mix;
    out[i * 4 + 1] = bgc + (pointColors[si + 1] - bgc) * mix;
    out[i * 4 + 2] = bb  + (pointColors[si + 2] - bb)  * mix;
    out[i * 4 + 3] = alpha;
  }
  return out;
}

const LINK_TINT_MIX = 0.55;
const LINK_TINT_ALPHA = 0.3;

function nodeSize(node: VizNode): number {
  const imp = Math.max(0, Math.min(1, node.importance ?? 0));
  // Base 0.5-2px. Multiplied by zoom level (scalePointsOnZoom=true), so at
  // the fit-after-settle zoom (~2x) points sit at 1-4px and grow
  // proportionally as the user zooms in.
  return 0.5 + imp * 1.5;
}

/**
 * Pull a resolvable file path out of a node id.
 * - File nodes: id IS the (relative) path.
 * - Symbol nodes: id is "relPath::name#kind" — slice before the first "::".
 * - Synthetic ids (e.g. "node:path.synthetic") have no real file on disk; we
 *   return them verbatim so the UI can still display/copy, but isRealFileId
 *   gates IDE-open actions.
 */
function extractFilePath(node: VizNode): string {
  const id = node.id ?? '';
  const sep = id.indexOf('::');
  return sep === -1 ? id : id.slice(0, sep);
}

function isRealFileId(node: VizNode): boolean {
  const id = node.id ?? '';
  if (!id) return false;
  if (id.endsWith('.synthetic')) return false;
  if (id.startsWith('node:')) return false;
  return true;
}

/**
 * Initial zoom level chosen so the entire spaceSize fits comfortably inside
 * the current viewport — so the initial random-disc of points renders near
 * screen-center, and force expansion stays on-screen without camera chase.
 */
function initialZoomFromSpaceSize(spaceSize: number, container: HTMLElement): number {
  const w = container.clientWidth || 1200;
  const h = container.clientHeight || 800;
  const viewport = Math.min(w, h);
  // 0.85 ratio leaves ~7% padding on each side, matches fitViewPadding feel.
  return Math.max(0.1, Math.min(2, (viewport * 0.85) / spaceSize));
}

/**
 * Lightweight RAF-based FPS meter. Refreshes display twice a second so the
 * digit doesn't flicker on every frame. Tier drives the accent color —
 * "good" green, "ok" amber, "bad" red — readable at a glance without
 * needing to parse the number.
 */
function FpsBadge({ show }: { show: boolean }) {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    if (!show) return;
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frames += 1;
      const dt = now - last;
      if (dt >= 500) {
        setFps(Math.round((frames * 1000) / dt));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [show]);
  if (!show) return null;
  const tier = fps >= 50 ? 'good' : fps >= 30 ? 'ok' : 'bad';
  return (
    <div className="cosmos-gpu-fps" data-tier={tier}>
      <span className="cosmos-gpu-fps-dot" />
      <span className="cosmos-gpu-fps-num">{fps}</span>
      <span className="cosmos-gpu-fps-unit">fps</span>
    </div>
  );
}

/**
 * Per-hop highlight palette. Index 0 = clicked seed, 1 = 1-hop neighbor, etc.
 * Hot-to-cool perceptual gradient so the user can tell "how far" a node is
 * from the click at a glance. Index >= length reuses the last entry.
 * Values are 0-1 RGB + alpha, matching setPointColors' Float32Array format.
 */
const DEPTH_COLORS: [number, number, number, number][] = [
  [1.00, 1.00, 1.00, 1.0],  // 0: seed — pure white
  [1.00, 0.40, 0.30, 1.0],  // 1: red-orange
  [1.00, 0.75, 0.20, 1.0],  // 2: gold
  [0.60, 0.90, 0.40, 1.0],  // 3: green
  [0.30, 0.70, 1.00, 1.0],  // 4: blue
  [0.70, 0.50, 1.00, 1.0],  // 5: purple
  [0.55, 0.55, 0.70, 1.0],  // 6+: muted slate
];

// Attach the top stack frame to an error message so the banner points at the
// actual failing callsite (cosmos.gl internal vs our code) — invaluable for
// diagnosing "Maximum call stack size exceeded" where the plain message says
// nothing about WHERE it blew up. RangeError stacks can be truncated; fall
// back to any single-line info we can extract.
function decorateErr(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const stack = e.stack ?? '';
  const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);
  const frame = lines.find((l) => l.startsWith('at ')) ?? lines[1] ?? '';
  return frame && !e.message.includes(' · ') ? new Error(`${e.message}  ·  ${frame}`) : e;
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
  // 2D canvas overlaid on cosmos.gl with mix-blend-mode: screen — paints a
  // soft radial-gradient glow around each top-importance node so they read
  // as glowing orbs instead of flat dots when zoomed in. Crowd of low-
  // importance points stays subtle; visual hierarchy emerges naturally.
  const haloCanvasRef = useRef<HTMLCanvasElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const nodesRef = useRef<VizNode[]>([]);
  const payloadRef = useRef<GraphPayload | null>(null);
  // Original per-point colors — snapshot taken in renderGraph so highlight
  // logic can restore colors after clearing a selection.
  const origColorsRef = useRef<Float32Array | null>(null);
  // id → previous render's index, used to carry settled positions over to
  // the next render so toggling a filter doesn't re-trigger the settle pass.
  const prevNodeIdsRef = useRef<Map<string, number> | null>(null);
  const indexByIdRef = useRef<Map<string, number>>(new Map());
  const labelIndicesRef = useRef<number[]>([]); // which point indices currently carry labels
  // One representative (most-important node) per community — used as the
  // "sections" overlay at default/zoomed-out views so we aren't dumping 20+
  // individual filenames on top of an unreadable cloud.
  const sectionIndicesRef = useRef<number[]>([]);
  // Override label text for section reps → community label (dominant dir),
  // not the representative node's own filename.
  const sectionLabelByIndexRef = useRef<Map<number, string>>(new Map());
  // When a highlight is active (click on a node), this holds per-node BFS depth
  // (index → hop-distance from seed). updateLabels narrows labels to depth ≤ 1,
  // and highlightNeighborhood uses it to colorize in-subgraph links.
  // null when no highlight is active.
  const highlightedDepthRef = useRef<Map<number, number> | null>(null);
  // Last link pair buffer pushed to cosmos.gl — needed by highlightNeighborhood
  // to recompute per-link colors based on the BFS subgraph.
  const linkPairsRef = useRef<Float32Array | null>(null);
  // Cached per-link tinted color buffer (shade of source node, lerped toward
  // background). Applied on render, on colorBy change, and on theme change.
  // clearHighlight restores from this instead of a flat theme-default color.
  const defaultLinkColorsRef = useRef<Float32Array | null>(null);
  const rafLabelRef = useRef<number | null>(null);
  // Throttles per-tick camera refit during simulation (see onSimulationTick).
  const lastTickFitRef = useRef<number>(0);
  // Whether we've already frozen the layout on this render cycle. Set true
  // inside onSimulationTick when alpha drops below the freeze threshold —
  // blocks us from pausing repeatedly or resuming the settle. Reset to
  // false at the start of each renderGraph call.
  const frozenRef = useRef<boolean>(false);
  // Set true as soon as the user zooms or pans the view. Suppresses the
  // throttled live-fit inside onSimulationTick so the user's camera isn't
  // fought by the auto-framing loop. Reset on each new renderGraph cycle
  // so the freshly-loaded graph gets its one initial fit.
  const userInteractedRef = useRef<boolean>(false);
  // Web Worker for off-main-thread edge dedup + top-K sort on big graphs.
  // Lazy — only instantiated when nCount > 3000.
  const workerRef = useRef<Worker | null>(null);
  // Monotonic token to ignore stale worker responses if a newer payload lands
  // while an older edge-build job is in flight.
  const renderTokenRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Auto-dismiss the error banner after 7s so transient blips (429, worker
  // flakes, network hiccups) don't leave a stale toast hanging on screen.
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 7000);
    return () => window.clearTimeout(t);
  }, [error]);
  const [stats, setStats] = useState<{ nodes: number; edges: number; communities: number } | null>(null);
  const [hovered, setHovered] = useState<VizNode | null>(null);
  const [selected, setSelected] = useState<VizNode | null>(null);
  // Toolbar-height tracking so popups offset past a wrapped 2-row pill.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState<number>(44);
  // IDE integration — populated once from main process; last-used remembered.
  const [ides, setIdes] = useState<{ id: string; name: string; bundlePath: string }[]>([]);
  const [lastIdeId, setLastIdeId] = useState<string>(() => {
    try { return localStorage.getItem('trace-mcp.lastIde') ?? ''; } catch { return ''; }
  });
  const [copied, setCopied] = useState<boolean>(false);

  // Measure toolbar height so overlays (selected popup, error banner) anchor
  // below it even when the pill wraps to 2 rows on narrow panes. Hardcoded
  // top-14 was the old bug: worked for 1 row, collided with row 2.
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const update = () => setToolbarHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Detect installed IDEs once. Quietly no-op outside Electron (dev in browser).
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.detectIdeApps) return;
    let alive = true;
    api.detectIdeApps().then((list) => { if (alive) setIdes(list); }).catch(() => { if (alive) setIdes([]); });
    return () => { alive = false; };
  }, []);
  const [theme, setTheme] = useState<'light' | 'dark'>(detectTheme());
  const [searchQuery, setSearchQuery] = useState('');
  const [live, setLive] = useState(true);           // Live = simulation running + breathing
  const [simRunning, setSimRunning] = useState(true); // polled from cosmos.gl
  // Synchronous mirror of `live` — onSimulationTick (fired from cosmos.gl's
  // RAF loop) reads this to decide whether to seamlessly re-heat alpha when
  // it decays; skipped when the user has paused via the Live toggle.
  const liveRef = useRef(live);
  useEffect(() => { liveRef.current = live; }, [live]);

  const { scope, granularity, hideIsolated, symbolKinds, maxNodes, colorBy, showLabels, showFPS } = settings;
  const HIGHLIGHT_DEPTH = 1;
  // Mirror `showLabels` into a ref so the RAF tick reads the latest value
  // directly without relying on useCallback dep propagation. Belt-and-suspenders
  // against any stale-closure scenarios in the label loop.
  const showLabelsRef = useRef(showLabels);
  showLabelsRef.current = showLabels;

  // Debounce text-input–driven refetches (symbolKinds, maxNodes) so typing
  // doesn't spam /api/projects/graph on every keystroke. 600ms is the sweet
  // spot — responsive on paste, forgiving during typing.
  const debouncedSymbolKinds = useDebounced(symbolKinds, 600);
  const debouncedMaxNodes = useDebounced(maxNodes, 600);

  const themeSpec = theme === 'dark' ? THEME_DARK : THEME_LIGHT;

  // ── Theme watcher ─────────────────────────────────────────────
  // Three sources: system preference, explicit override on <html data-theme>
  // (same-window toggle), and cross-window storage events (toggle in another
  // window). All three route through detectTheme() so the explicit override
  // always wins.
  useEffect(() => {
    const resync = () => setTheme(detectTheme());

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', resync);

    const observer = new MutationObserver(resync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const onStorage = (e: StorageEvent) => { if (e.key === 'trace-mcp-theme') resync(); };
    window.addEventListener('storage', onStorage);

    return () => {
      mq.removeEventListener('change', resync);
      observer.disconnect();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // ── focusNode (for imperative handle) ─────────────────────────
  const focusNode = useCallback((id: string) => {
    const graph = graphRef.current;
    const idx = indexByIdRef.current.get(id);
    if (!graph || idx == null) return;
    graph.fitViewByPointIndices([idx], 500, 0.3);
    const node = nodesRef.current[idx];
    if (node) setSelected(node);
    // Also apply neighborhood highlight
    highlightNeighborhood([idx]);
  }, []);
  useImperativeHandle(ref, () => ({ focusNode }), [focusNode]);

  // ── BFS-expand seeds to N hops, tinting each layer its own palette color ──
  // Depth 0 (clicked seed) = white, 1 = red-orange, 2 = gold, ... (DEPTH_COLORS).
  // We overwrite per-point colors for every highlighted node, then let cosmos.gl
  // grey-out the rest via selectPointsByIndices. This gives the user a visible
  // "how many hops away is each neighbor" answer at a glance.
  const highlightNeighborhood = useCallback((seeds: number[]) => {
    const graph = graphRef.current;
    const orig = origColorsRef.current;
    if (!graph || !orig || seeds.length === 0) return;
    const depth = HIGHLIGHT_DEPTH;

    // BFS with per-node depth tracking. `depthMap` records the shortest hop
    // distance we reached this node from any seed — that's what the color
    // gradient visualizes.
    const depthMap = new Map<number, number>();
    for (const s of seeds) depthMap.set(s, 0);
    let frontier = [...seeds];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: number[] = [];
      for (const idx of frontier) {
        const adj = graph.getAdjacentIndices(idx);
        if (!adj) continue;
        for (const n of adj) {
          if (!depthMap.has(n)) { depthMap.set(n, d); next.push(n); }
        }
      }
      frontier = next;
    }

    // Rewrite the color buffer: leave originals intact for non-highlighted
    // nodes (cosmos.gl will grey them), overwrite RGBA per-hop for the rest.
    const colors = new Float32Array(orig);
    for (const [idx, d] of depthMap) {
      const [r, g, b, a] = DEPTH_COLORS[Math.min(d, DEPTH_COLORS.length - 1)];
      colors[idx * 4]     = r;
      colors[idx * 4 + 1] = g;
      colors[idx * 4 + 2] = b;
      colors[idx * 4 + 3] = a;
    }
    graph.setPointColors(colors);
    const highlighted = Array.from(depthMap.keys());
    graph.selectPointsByIndices(highlighted);
    highlightedDepthRef.current = new Map(depthMap);

    // Colorize links: only BFS tree edges (one endpoint at hop d, the other at
    // d+1, up to the selected depth) get the accent. Same-depth "cross" edges
    // between siblings are NOT a relationship at the current depth — e.g. at
    // depth=1, an edge between two direct neighbors of the seed is actually a
    // 2-hop relationship (seed→A→B), so it must stay dimmed.
    const linkPairs = linkPairsRef.current;
    if (linkPairs && linkPairs.length >= 2) {
      const numLinks = Math.floor(linkPairs.length / 2);
      const linkColors = new Float32Array(numLinks * 4);
      const [hr, hg, hb, ha] = DEPTH_COLORS[1];
      for (let i = 0; i < numLinks; i++) {
        const s = linkPairs[i * 2] | 0;
        const t = linkPairs[i * 2 + 1] | 0;
        const sd = depthMap.get(s);
        const td = depthMap.get(t);
        const isTreeEdge = sd != null && td != null && sd !== td && Math.max(sd, td) <= depth;
        if (isTreeEdge) {
          linkColors[i * 4]     = hr;
          linkColors[i * 4 + 1] = hg;
          linkColors[i * 4 + 2] = hb;
          linkColors[i * 4 + 3] = ha;
        } else {
          // Non-tree edge (incl. sibling cross-edges between two neighbors at the
          // same BFS depth). Render fully transparent — we only want edges that
          // physically connect seed→neighbor to show at depth=1.
          linkColors[i * 4]     = 0;
          linkColors[i * 4 + 1] = 0;
          linkColors[i * 4 + 2] = 0;
          linkColors[i * 4 + 3] = 0;
        }
      }
      graph.setLinkColors(linkColors);
      graph.render();
    }

    // Disable distance-based fade while highlighting — cosmos.gl fades links
    // longer than `linkVisibilityDistanceRange[1]` pixels on screen, so zooming
    // in makes 1-hop edges (which span >400px) go invisible. Widen the range
    // to "virtually infinite" so all highlighted links stay fully opaque; our
    // per-link alphas already handle dimming the non-highlighted ones.
    graph.setConfig({ linkVisibilityDistanceRange: [100000, 200000] });
  }, []);

  const clearHighlight = useCallback(() => {
    const graph = graphRef.current;
    const orig = origColorsRef.current;
    if (!graph) return;
    graph.unselectPoints();
    // Restore original community/language/framework colors — highlight mode
    // had overwritten the buffer for highlighted nodes.
    if (orig) graph.setPointColors(new Float32Array(orig));
    // Reset link colors to the cached per-link tints (we overrode them per-link
    // in highlightNeighborhood, so cosmos.gl won't revert on its own).
    const tinted = defaultLinkColorsRef.current;
    if (tinted) {
      graph.setLinkColors(new Float32Array(tinted));
    }
    // Restore the distance-fade range we widened in highlightNeighborhood —
    // keep in sync with the values passed at Graph() construction.
    graph.setConfig({ linkVisibilityDistanceRange: [100, 400] });
    graph.render();
    highlightedDepthRef.current = null;
    setSelected(null);
  }, [themeSpec]);

  // ── Label overlay rendering ───────────────────────────────────
  // Updates HTML label positions every animation frame based on point screen positions.
  const updateLabels = useCallback(() => {
    const graph = graphRef.current;
    const layer = labelLayerRef.current;
    const nodes = nodesRef.current;
    if (!graph || !layer) return;

    const zoom = graph.getZoomLevel();
    // Labels toggle is the master switch — when off, wipe any existing labels
    // and bail before re-adding any. Reading via ref avoids any stale-closure
    // risk if the RAF loop outlives a dep change.
    const labelsOn = showLabelsRef.current;
    if (!labelsOn) {
      if (layer.children.length > 0) layer.replaceChildren();
      return;
    }
    // (hovered/selected node info still appears in the side panels). When on,
    // show hovered + selected + either the 1-hop subgraph (highlight mode) or
    // the default two-tier (sections zoomed out, top-N zoomed in).
    const indices = new Set<number>();
    const highlightedDepth = highlightedDepthRef.current;
    const highlightActive = highlightedDepth != null && highlightedDepth.size > 0;
    if (showLabels) {
      if (hovered) {
        const i = indexByIdRef.current.get(hovered.id);
        if (i != null) indices.add(i);
      }
      if (selected) {
        const i = indexByIdRef.current.get(selected.id);
        if (i != null) indices.add(i);
      }
      if (highlightActive) {
        // Highlight mode: show labels for seed + 1-hop neighbors.
        for (const [idx, d] of highlightedDepth) {
          if (d <= 1) indices.add(idx);
        }
      } else {
        // Two-tier label strategy:
        //  * Zoomed-out (default view): show ONE label per community — the
        //    "section headings" of the graph. At this scale individual file
        //    names are illegible anyway; users want to see the high-level
        //    structure.
        //  * Zoomed-in: progressively reveal top-N individual nodes by
        //    importance, since the user is now close enough to read them.
        if (zoom < 0.5) {
          // nothing — too far out to read anything
        } else if (zoom < 2) {
          // sections only — cap to the densest groups so we don't crowd
          const cap = zoom < 1 ? 8 : 14;
          for (const idx of sectionIndicesRef.current.slice(0, cap)) indices.add(idx);
        } else {
          const cap = zoom > 3.5 ? 60 : 24;
          for (const idx of labelIndicesRef.current.slice(0, cap)) indices.add(idx);
        }
      }
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

    // Read positions ONCE per frame — getPointPositions() copies a buffer
    // from WebGL to JS; calling it inside the loop cost us N×50 copies per
    // frame when displaying 50 labels. Now: one copy, O(1) lookups.
    const positions = graph.getPointPositions();
    for (let i = 0; i < wanted.length; i++) {
      const idx = wanted[i];
      const node = nodes[idx];
      if (!node) continue;
      const sx = positions[idx * 2];
      const sy = positions[idx * 2 + 1];
      if (!Number.isFinite(sx)) continue;
      const screen = graph.spaceToScreenPosition([sx, sy]);
      const el = pool[i];
      const sectionText = sectionLabelByIndexRef.current.get(idx);
      const isSection = sectionText != null && !highlightActive && hovered?.id !== node.id && selected?.id !== node.id;
      el.textContent = isSection ? sectionText : shortLabel(node);
      el.dataset.kind = isSection ? 'section' : 'node';
      el.style.transform = `translate(${screen[0]}px, ${screen[1]}px)`;
      // Highlight hovered/selected
      el.dataset.state = hovered?.id === node.id || selected?.id === node.id ? 'active' : 'normal';
    }

    // Halo pass — soft additive glow around top-importance nodes. Reads
    // SPACE coords from the tracked-positions FBO (populated by a
    // dedicated GPU pass sampled from currentPositionFbo every tick), so
    // halos stay in lock-step with the rendered dots even while the
    // simulation is continuously re-heated. Using getPointPositions()
    // here caused visible halo/point drift: that path copies the whole
    // position FBO via readPixels on demand, whose timing can fall out
    // of phase with the swap between current/previousPositionFbo during
    // an active simulation step. Tracked positions also scale to O(K)
    // GPU→CPU bytes instead of O(N), so the per-frame cost is bounded
    // by the halo count regardless of graph size.
    const halo = haloCanvasRef.current;
    const orig = origColorsRef.current;
    if (halo && orig) {
      const ctx = halo.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, halo.width, halo.height);
        // Inside-canvas additive blending so overlapping halos brighten;
        // outside the canvas, mix-blend-mode: screen handles the cosmos.gl
        // composite (set on the <canvas> element style).
        ctx.globalCompositeOperation = 'lighter';
        const tracked = graph.getTrackedPointPositionsMap();
        for (const [idx, pos] of tracked) {
          const sx = pos[0];
          const sy = pos[1];
          if (!Number.isFinite(sx)) continue;
          const [hx, hy] = graph.spaceToScreenPosition([sx, sy]);
          const r = orig[idx * 4]     * 255;
          const g = orig[idx * 4 + 1] * 255;
          const b = orig[idx * 4 + 2] * 255;
          // Halo radius scales with importance × current zoom so glows track
          // the visible point size; importance-0 still gets a small base halo.
          const imp = nodes[idx]?.importance ?? 0;
          const radius = (8 + imp * 18) * Math.max(0.6, Math.min(3, zoom));
          const grad = ctx.createRadialGradient(hx, hy, 0, hx, hy, radius);
          grad.addColorStop(0,    `rgba(${r|0}, ${g|0}, ${b|0}, 0.35)`);
          grad.addColorStop(0.45, `rgba(${r|0}, ${g|0}, ${b|0}, 0.10)`);
          grad.addColorStop(1,    `rgba(${r|0}, ${g|0}, ${b|0}, 0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(hx, hy, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }, [hovered, selected, showLabels]);

  // Halo canvas DPR-aware sizing (matches container CSS pixels).
  useEffect(() => {
    const canvas = haloCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Keep labels updated via RAF loop, throttled to ~30fps. Labels don't need
  // to track the solver at 60fps — the eye can't tell, and halving the rate
  // frees GPU→CPU buffer reads + DOM transform writes on large graphs.
  useEffect(() => {
    let running = true;
    let lastTs = 0;
    const MIN_INTERVAL = 33; // ~30fps
    const tick = (ts: number) => {
      if (!running) return;
      // Skip updates when offscreen — RAF still fires in Electron but
      // there's nothing to draw. Saves position reads + DOM writes entirely.
      if (!offscreenPausedRef.current && ts - lastTs >= MIN_INTERVAL) {
        updateLabels();
        lastTs = ts;
      }
      rafLabelRef.current = requestAnimationFrame(tick);
    };
    rafLabelRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      if (rafLabelRef.current != null) cancelAnimationFrame(rafLabelRef.current);
    };
  }, [updateLabels]);

  // Immediate cleanup when the Labels toggle turns off — don't wait for the
  // next RAF tick (up to ~33ms delay). Wipes every label div in the overlay.
  useEffect(() => {
    if (!showLabels && labelLayerRef.current) {
      labelLayerRef.current.replaceChildren();
    }
  }, [showLabels]);

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

    // Retry on 429 with exponential backoff. The daemon exempts localhost,
    // but the limiter can still trip when the client IP resolves to something
    // unexpected (e.g. ::ffff:… variants on some setups), or when multiple
    // tools burst through the same endpoint. 3 attempts × (400/800/1600ms).
    const MAX_ATTEMPTS = 3;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(`${BASE}/api/projects/graph?${params}`);
        if (resp.status === 429) {
          const delay = 400 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
          lastErr = new Error('Too many requests (retrying…)');
          continue;
        }
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error(body.error ?? `Server error (${resp.status})`);
        }
        const data = (await resp.json()) as GraphPayload;
        payloadRef.current = data;
        try {
          renderGraph(data);
        } catch (renderErr) {
          // eslint-disable-next-line no-console
          console.error('[graph] renderGraph failed', renderErr);
          throw decorateErr(renderErr);
        }
        setStats({ nodes: data.nodes.length, edges: data.edges.length, communities: data.communities.length });
        setLoading(false);
        return;
      } catch (e: unknown) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        // Don't retry on non-429 errors
        if (!(e instanceof Error) || !e.message.includes('Too many requests')) break;
      }
    }
    setError(lastErr ? lastErr.message : 'Failed to load graph');
    setLoading(false);
  }, [root, scope, granularity, hideIsolated, debouncedSymbolKinds, debouncedMaxNodes]);

  // Render (or re-render) the graph from a payload. Reuses existing Graph instance.
  const renderGraph = useCallback((data: GraphPayload) => {
    const container = containerRef.current;
    if (!container) return;

    // Adaptive perf knobs — scale detail down as the graph grows so GPU
    // fragment-shader cost stays roughly flat across sizes.
    const nCount = data.nodes.length;
    const bigGraph = nCount > 3000;
    const hugeGraph = nCount > 8000;
    const adaptivePointSize = hugeGraph ? 3 : bigGraph ? 4 : 6;
    const adaptiveLinkWidth = hugeGraph ? 0.5 : bigGraph ? 0.7 : 0.9;
    const adaptiveLinkArrows = !bigGraph; // arrows are a separate pass — kill them on large graphs
    // cosmos.gl simulates in a square "space" whose size controls the size
    // of the force textures (position/velocity/link). Larger space = larger
    // textures = slower simulation and more GPU memory. Nearest power-of-two
    // that comfortably holds the node cloud keeps textures small.
    const adaptiveSpaceSize = hugeGraph ? 8192 : bigGraph ? 4096 : 2048;

    // Snapshot the previous render's settled positions BEFORE we potentially
    // destroy the Graph instance — see carry-over loop below. cosmos.gl's
    // internal state sometimes mis-recurses ("Maximum call stack size") when
    // setPointPositions is called with a very different N on an existing
    // graph, so we prefer destroy+create on re-render over in-place mutation.
    // Invalidate cached link pairs — a new render will push fresh links
    // through finalize. Clicking between now and finalize has no subgraph
    // to color, which is the right behavior (old links are gone).
    linkPairsRef.current = null;
    // Stale highlight depth references indices into the OLD node array —
    // updateLabels would otherwise iterate them, reading positions that no
    // longer correspond to the same nodes. Clear before the swap.
    highlightedDepthRef.current = null;
    // Reset the fit-done flag BEFORE the new Graph() is constructed.
    // cosmos.gl starts its RAF/tick loop immediately on construction, so
    // onSimulationTick can fire before finalize() runs — if frozenRef is
    // stale from the previous render, the freshly-built graph would skip
    // its one initial fit-view pass.
    frozenRef.current = false;
    userInteractedRef.current = false;

    const prevGraph = graphRef.current;
    let carryPositions: number[] | Float32Array | null = null;
    if (prevGraph) {
      try {
        const p = prevGraph.getPointPositions();
        if (p && p.length > 0) carryPositions = p;
      } catch { /* ignore — fall through to random */ }
      try { prevGraph.destroy?.(); } catch { /* ignore */ }
      graphRef.current = null;
      container.innerHTML = ''; // remove the old canvas so the new Graph mounts cleanly
    }

    let graph = graphRef.current;
    if (!graph) {
      graph = new Graph(container, {
        backgroundColor: themeSpec.background,
        pointDefaultColor: themeSpec.pointDefaultColor,
        linkDefaultColor: themeSpec.linkColor,
        hoveredLinkColor: themeSpec.hoveredLink,
        pointSize: adaptivePointSize,
        linkWidth: adaptiveLinkWidth,
        linkArrows: adaptiveLinkArrows,
        linkArrowsSizeScale: 0.6,
        // Higher floor = fewer near-camera link fragments shaded every frame.
        // Wider far end = distant links fade smoothly instead of pop-culling.
        linkVisibilityDistanceRange: [100, 400],
        linkVisibilityMinTransparency: 0.05,
        scalePointsOnZoom: true,
        spaceSize: adaptiveSpaceSize,
        renderHoveredPointRing: true,
        hoveredPointRingColor: themeSpec.hoveredLink,
        // Greyout — applied automatically when any points are selected.
        pointGreyoutOpacity: 0.08,
        linkGreyoutOpacity: 0.05,
        // Force-directed tuning. Gravity/repulsion balance governs how
        // tightly clusters pack: too much gravity → one dense ball with
        // no visible sub-structure; too little → cloud escapes spaceSize.
        // 2.0 gravity + 1.2 repulsion + 16 link distance gives communities
        // visible breathing room while keeping isolated (linkless) nodes in
        // the main mass's halo. Link distance 16 (2× old 8) is the primary
        // knob for inter-cluster separation — longer springs pull connected
        // components apart into readable sub-clusters.
        simulationGravity: 2.0,
        // Repulsion shader grows as ~c/sqrt(dist) at close range, so any
        // initial cluster of near-neighbors gets huge first-tick deltas —
        // the visible "jumping". Holding repulsion at 0.9 (down from 1.2)
        // keeps sub-community structure readable (gravity still wins at
        // large distances) while capping the short-range force spike that
        // makes individual points pop between frames.
        simulationRepulsion: 0.9,
        // Friction is a per-tick velocity retention multiplier (higher = less
        // damping). 0.85 keeps motion visibly dynamic but filters the big
        // first-tick kicks that made points "teleport" — the rendered frame
        // delta is ~15% smaller than at 0.92, enough to read as smooth flow
        // instead of snapping.
        simulationFriction: 0.85,
        simulationLinkSpring: 1.0,
        simulationLinkDistance: 16,
        // Fixed gentle decay — no user slider. Higher value = alpha decays
        // slower = longer, gentler settle. 2500 gives ~5s of visible motion
        // on a laptop before the alpha<0.2 freeze kicks in; earlier 0.5×
        // slider default mapped to 4000 which was unnecessarily long.
        simulationDecay: 2500,
        // Start pre-zoomed-out so random-disc init is centered on screen and
        // the whole spaceSize is visible. No auto-fit while sim runs — camera
        // chase was jerky, better to let the cloud expand within the frame
        // and fit smoothly ONCE at the end.
        initialZoomLevel: initialZoomFromSpaceSize(adaptiveSpaceSize, container),
        fitViewOnInit: false,
        // Three jobs, all throttled against cosmos.gl's RAF-driven tick rate:
        //   1. Live-track the expanding cloud with instant (0 ms) refits
        //      every 500 ms so the user doesn't wait for settle to end
        //      before the view is framed on the actual layout.
        //   2. Fit-and-mark at alpha < 0.15 (frozenRef flips true) — one
        //      smooth final fit once the cloud has mostly settled. The
        //      simulation keeps running; frozenRef just gates further fits.
        // Continuous motion is handled in a separate wall-clock interval
        // (see the breathing useEffect below) — not here — because
        // onSimulationTick stops firing once cosmos.gl considers the sim
        // ended (alpha < ALPHA_MIN), so a callback-driven re-heat can
        // never recover from a full decay.
        // try/catch is load-bearing: this callback is invoked from inside
        // cosmos.gl's RAF loop, outside our render-time error boundary —
        // a throw here would otherwise escape to the host and kill the app.
        onSimulationTick: (alpha: number) => {
          try {
            const g = graphRef.current;
            if (!g) return;
            // One-shot final fit when the initial settle is "done enough".
            if (!frozenRef.current && alpha < 0.15) {
              frozenRef.current = true;
              if (!userInteractedRef.current) g.fitView(800, 0.2);
            }
            if (frozenRef.current) return;
            // Live-fit — disabled after any user zoom/pan so scroll-to-zoom
            // isn't clobbered by the next throttled refit.
            if (userInteractedRef.current) return;
            if (alpha < 0.25) return;
            const now = performance.now();
            if (now - lastTickFitRef.current < 500) return;
            lastTickFitRef.current = now;
            g.fitView(0, 0.2);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[graph:onSimulationTick] tick handler skipped', err);
          }
        },
        onZoomStart: (_e: unknown, userDriven: boolean) => {
          if (userDriven) userInteractedRef.current = true;
        },
        showFPSMonitor: false,
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

    // Positions: reuse any previously-settled positions we already have for
    // nodes that survived a filter change (Isolated toggle, maxNodes tweak,
    // granularity switch). Only genuinely new nodes get random-disc init.
    // Without this, toggling any setting would re-run the big settle pass.
    const N = nodes.length;
    // Initial random-disc radius. Short-range repulsion in the manybody
    // shader spikes as c/sqrt(dist) for close pairs — the visible "jumping"
    // at sim start came from this: thousands of points in a tight cluster
    // produce giant first-tick deltas. Seeding across 40% of spaceSize
    // thins initial density ~2.5×, so alpha=1.0 forces stay bounded and the
    // opening frames look like flow rather than snap. Gravity still pulls
    // the cloud back to center within a few seconds.
    const initRadius = adaptiveSpaceSize * 0.4;
    const positions = new Float32Array(N * 2);
    const prevIds = prevNodeIdsRef.current;
    // cosmos.gl's coordinate space is [0, spaceSize] with origin at the
    // corner — the position shader hard-clamps to this range. Gravity pulls
    // toward spaceSize/2, so initialize around the same center; without this
    // offset, half the random-disc init lands at negative coords and piles
    // up against the x=0 / y=0 edges as visible clamp lines.
    const cx = adaptiveSpaceSize / 2;
    const cy = adaptiveSpaceSize / 2;
    // Always recenter carry positions so their bbox centroid aligns with
    // (cx, cy). The previous "only shift if out of range" variant missed
    // cases where the old layout was nominally in [0, spaceSize] but
    // clustered in one quadrant (e.g. carried from a smaller spaceSize, or
    // from an earlier build that centered init on origin but all points
    // happened to land in the positive half). Unconditional recentering
    // handles all coordinate-system mismatches — for carry positions that
    // are already centered, (cx - centroid) is ~0 so it's a no-op.
    let carryDx = 0;
    let carryDy = 0;
    if (carryPositions && carryPositions.length >= 2) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < carryPositions.length; i += 2) {
        const x = carryPositions[i];
        const y = carryPositions[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      carryDx = cx - (minX + maxX) / 2;
      carryDy = cy - (minY + maxY) / 2;
    }
    for (let i = 0; i < N; i++) {
      const prevIdx = carryPositions && prevIds ? prevIds.get(nodes[i].id) : undefined;
      const carriedX = prevIdx != null && carryPositions ? carryPositions[prevIdx * 2] : undefined;
      const carriedY = prevIdx != null && carryPositions ? carryPositions[prevIdx * 2 + 1] : undefined;
      if (Number.isFinite(carriedX) && Number.isFinite(carriedY)) {
        positions[i * 2]     = (carriedX as number) + carryDx;
        positions[i * 2 + 1] = (carriedY as number) + carryDy;
      } else {
        // New node — uniform-area random disc (sqrt for uniform radial density).
        const r = initRadius * Math.sqrt(Math.random());
        const a = Math.random() * 2 * Math.PI;
        positions[i * 2]     = cx + Math.cos(a) * r;
        positions[i * 2 + 1] = cy + Math.sin(a) * r;
      }
    }
    // Snapshot id → index for the NEXT re-render's carry-over lookup.
    const newIdMap = new Map<string, number>();
    for (let i = 0; i < N; i++) newIdMap.set(nodes[i].id, i);
    prevNodeIdsRef.current = newIdMap;

    // Colors (per-point RGBA, all channels normalized 0-1 — cosmos.gl buffer convention)
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

    // Top-N important nodes for label overlay defaults
    const topByImp = [...nodes.keys()].sort(
      (a, b) => (nodes[b].importance ?? 0) - (nodes[a].importance ?? 0),
    );
    labelIndicesRef.current = topByImp.slice(0, 60);

    // Section reps: the single most-important node per community. Ordered by
    // community size (biggest section first) so the zoomed-out cap keeps the
    // labels the user most wants to see.
    const bestByCommunity = new Map<number, { idx: number; imp: number }>();
    const sizeByCommunity = new Map<number, number>();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const imp = n.importance ?? 0;
      sizeByCommunity.set(n.community, (sizeByCommunity.get(n.community) ?? 0) + 1);
      const cur = bestByCommunity.get(n.community);
      if (!cur || imp > cur.imp) bestByCommunity.set(n.community, { idx: i, imp });
    }
    sectionIndicesRef.current = [...bestByCommunity.entries()]
      .sort((a, b) => (sizeByCommunity.get(b[0]) ?? 0) - (sizeByCommunity.get(a[0]) ?? 0))
      .map(([, v]) => v.idx);
    const commLabels = new Map<number, string>();
    for (const c of data.communities) commLabels.set(c.id, c.label);
    const sectionLabels = new Map<number, string>();
    for (const [commId, v] of bestByCommunity) {
      const lbl = commLabels.get(commId);
      if (lbl) sectionLabels.set(v.idx, lbl);
    }
    sectionLabelByIndexRef.current = sectionLabels;

    // Push the point data immediately — user sees nodes even before edges
    // finish processing on big graphs.
    graph.setPointPositions(positions);
    graph.setPointColors(colors);
    graph.setPointSizes(sizes);
    // Register the subset the halo pass wants. cosmos.gl then runs a
    // per-tick GPU copy of just these indices into trackedPositionsFbo,
    // which the halo pass reads via getTrackedPointPositionsMap(). The
    // subset is re-registered on every renderGraph cycle because
    // labelIndicesRef is rebuilt from the new nodes array (indices only
    // stay valid within a single cycle).
    graph.trackPointPositionsByIndices(labelIndicesRef.current);
    // Snapshot so highlightNeighborhood can rewrite colors per hop-distance
    // and clearHighlight can restore them. Copy because `colors` is reused
    // by the GPU buffer.
    origColorsRef.current = new Float32Array(colors);

    // Cap the opening alpha. cosmos.gl auto-starts at alpha=1.0 — per-tick
    // forces `delta = alpha × force` are then at full magnitude and
    // close-pair repulsion spikes make individual points visibly pop.
    // Called AFTER setPointPositions/Colors/Sizes so the first processed
    // render tick already has the freshly-uploaded point data; calling
    // it before the data is set caused cosmos.gl to advance a zero-point
    // simulation and leave internal scale/force state in an intermediate
    // configuration that didn't match what the halo pass expected.
    graph.start(0.4);

    // Edge processing: dedup + top-K sort. On big graphs this can freeze
    // the main thread for 100–300ms, so delegate to a Worker. Small graphs
    // stay synchronous — worker hop isn't worth the latency below ~3k nodes.
    const EDGE_BUDGET = 20000;
    const token = ++renderTokenRef.current;

    const finalize = (links: Float32Array) => {
      // Discard stale worker responses
      if (token !== renderTokenRef.current) return;
      const g = graphRef.current;
      if (!g) return;
      try {
        g.setLinks(links);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[graph] setLinks failed', err);
        setError(decorateErr(err).message);
        return;
      }
      // Cache pairs so highlightNeighborhood can rewrite per-link colors for
      // the 1-hop subgraph. Copy because cosmos.gl may retain the underlying
      // buffer for GPU upload.
      linkPairsRef.current = new Float32Array(links);
      // Compute & push per-link tints (shade of source node's color). Falls
      // back silently to linkDefaultColor if point colors aren't ready yet.
      const srcPointColors = origColorsRef.current;
      if (srcPointColors) {
        const tinted = computeTintedLinkColors(
          srcPointColors,
          linkPairsRef.current,
          hexToRgb01(themeSpec.background),
          LINK_TINT_MIX,
          LINK_TINT_ALPHA,
        );
        defaultLinkColorsRef.current = tinted;
        g.setLinkColors(new Float32Array(tinted));
      }
      // cosmos.gl auto-starts the simulation on new Graph() when
      // enableSimulation is true (default). No manual start() needed.
      // A redundant render() call wakes the draw loop after setLinks.
      try {
        g.render();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[graph] render failed', err);
        setError(decorateErr(err).message);
        return;
      }
      // Immediate fit so the user sees the layout framed from the first
      // frame — especially valuable on re-renders with carry-over positions
      // where the cloud is already spread. Deferred one frame so cosmos.gl
      // has the freshly-set positions in the FBO when fitView computes the
      // bounding box. onSimulationTick (throttled to 500 ms, re-armed below)
      // takes over from here to track the cloud as it expands during settle.
      requestAnimationFrame(() => {
        const gg = graphRef.current;
        if (gg) gg.fitView(500, 0.2);
      });
      // Arm onSimulationTick to fit on the first tick (throttle starts at 0).
      lastTickFitRef.current = 0;
      // New render cycle — unfreeze so the fresh settle pass can progress
      // to its own freeze threshold. Without this reset, the next render
      // would never run forces (frozenRef stays true from previous cycle).
      frozenRef.current = false;
    };

    // Inline edge-build fallback — used directly for small graphs and as a
    // safety net when the Worker path fails to initialize.
    const buildEdgesInline = (): Float32Array => {
      const seenPairs = new Set<number>();
      const pairA: number[] = [];
      const pairB: number[] = [];
      const pairWeight: number[] = [];
      for (const e of data.edges) {
        const s = indexById.get(e.source);
        const t = indexById.get(e.target);
        if (s == null || t == null) continue;
        const key = s * 0x100000 + t;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        pairA.push(s);
        pairB.push(t);
        pairWeight.push((nodes[s].importance ?? 0) + (nodes[t].importance ?? 0));
      }
      let keepIdx: Uint32Array;
      if (pairA.length > EDGE_BUDGET) {
        const order = new Uint32Array(pairA.length);
        for (let i = 0; i < order.length; i++) order[i] = i;
        const sorted = Array.from(order).sort((a, b) => pairWeight[b] - pairWeight[a]);
        keepIdx = Uint32Array.from(sorted.slice(0, EDGE_BUDGET));
      } else {
        keepIdx = new Uint32Array(pairA.length);
        for (let i = 0; i < keepIdx.length; i++) keepIdx[i] = i;
      }
      const out = new Float32Array(keepIdx.length * 2);
      for (let i = 0; i < keepIdx.length; i++) {
        const k = keepIdx[i];
        out[i * 2] = pairA[k];
        out[i * 2 + 1] = pairB[k];
      }
      return out;
    };

    if (bigGraph) {
      // Lazy worker — create once, reuse. Vite bundles via new URL().
      // Guard with try/catch — in some Electron packaging modes the Worker
      // URL resolution can fail at runtime; we fall back to inline build
      // rather than crash the whole render.
      try {
        if (!workerRef.current) {
          workerRef.current = new Worker(
            new URL('./graph-worker.ts', import.meta.url),
            { type: 'module' },
          );
          workerRef.current.addEventListener('error', (err) => {
            // eslint-disable-next-line no-console
            console.warn('[graph-worker] error, falling back to inline', err.message);
            workerRef.current?.terminate();
            workerRef.current = null;
          });
        }
        const worker = workerRef.current;
        const onMessage = (ev: MessageEvent<{ type: string; links: Float32Array }>) => {
          if (ev.data?.type !== 'edges') return;
          worker.removeEventListener('message', onMessage);
          finalize(ev.data.links);
        };
        worker.addEventListener('message', onMessage);

        const importanceArr = new Float32Array(nodes.length);
        for (let i = 0; i < nodes.length; i++) importanceArr[i] = nodes[i].importance ?? 0;

        const edgesFlat = data.edges.map((e) => ({ source: e.source, target: e.target }));
        const nodeIds = nodes.map((n) => n.id);

        worker.postMessage(
          {
            type: 'build-edges',
            nodes: nodeIds,
            edges: edgesFlat,
            importance: importanceArr,
            edgeBudget: EDGE_BUDGET,
          },
          [importanceArr.buffer],
        );
        // NOTE: intentionally NOT calling setLinks(empty) here — some cosmos.gl
        // code paths misbehave with zero-length link buffers. The previous
        // links (from the prior render, if any) stay on-screen until the
        // worker returns fresh ones, which is fine visually.
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[graph-worker] init failed, inline fallback', err);
        finalize(buildEdgesInline());
      }
    } else {
      // Small graph — inline is faster than a worker round-trip.
      finalize(buildEdgesInline());
    }
  }, [themeSpec, colorBy, showFPS]);

  // ── Reset edge-worker + position carry-over on granularity switch ──
  // File-graph and symbol-graph node-id namespaces don't overlap, so carrying
  // positions or reusing the worker's in-flight state across the switch adds
  // risk without benefit. The previous worker may still hold a pending job
  // whose response would race the fresh render.
  const prevGranularityRef = useRef(granularity);
  useEffect(() => {
    if (prevGranularityRef.current === granularity) return;
    prevGranularityRef.current = granularity;
    prevNodeIdsRef.current = null;
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
  }, [granularity]);

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
    // Re-snapshot — clearHighlight should restore the NEW colorBy palette,
    // not the pre-switch one.
    origColorsRef.current = new Float32Array(colors);
    // Rebuild per-link tints against the new node palette so edges stay in
    // sync with their source nodes (e.g. community → language recolor).
    const linkPairs = linkPairsRef.current;
    if (linkPairs && linkPairs.length >= 2) {
      const tinted = computeTintedLinkColors(
        colors,
        linkPairs,
        hexToRgb01(themeSpec.background),
        LINK_TINT_MIX,
        LINK_TINT_ALPHA,
      );
      defaultLinkColorsRef.current = tinted;
      graph.setLinkColors(new Float32Array(tinted));
    }
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
    // Tints lerp toward background, so background change ⇒ recompute tints.
    const pointColors = origColorsRef.current;
    const linkPairs = linkPairsRef.current;
    if (pointColors && linkPairs && linkPairs.length >= 2) {
      const tinted = computeTintedLinkColors(
        pointColors,
        linkPairs,
        hexToRgb01(themeSpec.background),
        LINK_TINT_MIX,
        LINK_TINT_ALPHA,
      );
      defaultLinkColorsRef.current = tinted;
      graph.setLinkColors(new Float32Array(tinted));
    }
    graph.render();
  }, [themeSpec]);

  // FPS is rendered by the custom <FpsBadge/> overlay below — cosmos.gl's
  // built-in Stats.js panel is intentionally off (see showFPSMonitor: false).

  // ── Pause simulation + label RAF when component is offscreen ───
  // If the user switches tabs away from the graph, Electron keeps RAF
  // firing at full rate (it's not the same as a backgrounded tab in a
  // browser). IntersectionObserver + Page Visibility API cut that cost
  // to zero whenever nothing is actually being looked at.
  const offscreenPausedRef = useRef(false);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const applyVisibility = (visible: boolean) => {
      const g = graphRef.current;
      if (!g) return;
      if (!visible && !offscreenPausedRef.current) {
        g.pause();
        offscreenPausedRef.current = true;
      } else if (visible && offscreenPausedRef.current) {
        // Only resume if the user hasn't manually paused via Live toggle
        if (live) g.unpause();
        offscreenPausedRef.current = false;
      }
    };

    const io = new IntersectionObserver(
      ([entry]) => applyVisibility(entry.isIntersecting && entry.intersectionRatio > 0),
      { threshold: 0 },
    );
    io.observe(container);

    const onDocVisibility = () => applyVisibility(!document.hidden);
    document.addEventListener('visibilitychange', onDocVisibility);

    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onDocVisibility);
    };
  }, [live]);

  // ── Breathing interval ────────────────────────────────────────
  // Wall-clock re-heat: every 2.5 s, if the user hasn't paused via Live,
  // bump alpha back up with `graph.start(0.15)`. This has to be a plain
  // setInterval — not a callback from onSimulationTick — because cosmos.gl
  // stops invoking the tick callback once alpha decays below ALPHA_MIN
  // (0.001), so a tick-driven re-heat can never recover from full decay.
  // `isSimulationRunning`-guarded unpause handles the "resumed from a full
  // stop" case that pause/unpause alone can't restart.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      const g = graphRef.current;
      if (!g) return;
      if (!liveRef.current) return;
      try {
        g.start(0.15);
        if (!simRunning) setSimRunning(true);
      } catch {
        /* graph destroyed between ticks — next interval is a no-op */
      }
    }, 2500);
    return () => window.clearInterval(id);
  }, [live, simRunning]);

  // ── Live / Paused toggle ──────────────────────────────────────
  // Pauses or resumes the solver. The breathing interval above keeps the
  // simulation continuously re-heated while live=true; when live flips
  // false we pause cosmos.gl and the interval effect tears itself down.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    if (live) {
      // If alpha has decayed past the re-heat threshold and the sim has
      // naturally stopped, bump it back up so the toggle takes visible
      // effect. Otherwise a simple unpause is enough.
      if (!graph.isSimulationRunning) graph.start(0.12);
      else graph.unpause();
      setSimRunning(graph.isSimulationRunning);
    } else {
      graph.pause();
      setSimRunning(false);
    }
  }, [live, stats]);

  // ── Cleanup on unmount ────────────────────────────────────────
  useEffect(() => {
    return () => {
      try {
        graphRef.current?.destroy?.();
      } catch { /* ignore */ }
      graphRef.current = null;
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
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
    const depth = HIGHLIGHT_DEPTH;
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

      <FpsBadge show={showFPS} />

      {/* A/B PROBE: halo overlay disabled. mix-blend-mode:screen forces
          Chromium into software compositing for the whole stacking context;
          testing if removal lifts FPS. Revert if halos are wanted visually. */}
      <canvas
        ref={haloCanvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ display: 'none' }}
      />

      {/* Label overlay — HTML over canvas, clipped by root's overflow-hidden */}
      <div
        ref={labelLayerRef}
        className="absolute inset-0 pointer-events-none overflow-hidden"
        style={{
          color: isDark ? '#e4e4ea' : '#1d1d1f',
          fontSize: 10,
          fontFamily: sysFont,
          lineHeight: 1,
          // Belt-and-suspenders: even if updateLabels leaves stale label
          // divs in the pool, CSS hides the entire overlay when labels are off.
          display: showLabels ? undefined : 'none',
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
          text-shadow: none;
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
        .cosmos-gpu-fps {
          position: absolute;
          top: 10px;
          right: 10px;
          z-index: 30;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 9px 4px 8px;
          border-radius: 999px;
          font: 500 11px/1 "SF Mono", ui-monospace, Menlo, Monaco, monospace;
          letter-spacing: -0.01em;
          color: ${isDark ? 'rgba(235,237,242,0.92)' : 'rgba(20,22,26,0.92)'};
          background: ${isDark ? 'rgba(20,22,26,0.55)' : 'rgba(255,255,255,0.65)'};
          border: 0.5px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
          backdrop-filter: blur(10px) saturate(160%);
          -webkit-backdrop-filter: blur(10px) saturate(160%);
          box-shadow: 0 1px 2px rgba(0,0,0,0.15), 0 4px 14px rgba(0,0,0,0.18);
          user-select: none;
          pointer-events: none;
          font-variant-numeric: tabular-nums;
        }
        .cosmos-gpu-fps-dot {
          width: 6px; height: 6px; border-radius: 999px;
          background: currentColor;
          box-shadow: 0 0 6px currentColor;
          opacity: 0.9;
        }
        .cosmos-gpu-fps-num { font-weight: 600; font-size: 12px; }
        .cosmos-gpu-fps-unit { opacity: 0.55; font-size: 10px; }
        .cosmos-gpu-fps[data-tier="good"] { color: #42d392; }
        .cosmos-gpu-fps[data-tier="ok"]   { color: #f5b84a; }
        .cosmos-gpu-fps[data-tier="bad"]  { color: #ff6a6a; }
        .cosmos-gpu-fps[data-tier="good"] .cosmos-gpu-fps-num,
        .cosmos-gpu-fps[data-tier="ok"]   .cosmos-gpu-fps-num,
        .cosmos-gpu-fps[data-tier="bad"]  .cosmos-gpu-fps-num { color: ${isDark ? '#f5f6fa' : '#141618'}; }
        .cosmos-gpu-fps[data-tier="good"] .cosmos-gpu-fps-unit,
        .cosmos-gpu-fps[data-tier="ok"]   .cosmos-gpu-fps-unit,
        .cosmos-gpu-fps[data-tier="bad"]  .cosmos-gpu-fps-unit { color: ${isDark ? 'rgba(235,237,242,0.5)' : 'rgba(20,22,26,0.5)'}; }
      `}</style>

      {/* ── Floating toolbar — constrained to card width, wraps if needed ── */}
      <div
        ref={toolbarRef}
        className="absolute top-2.5 z-30 flex items-center gap-1 px-2 py-1.5"
        style={{
          ...pillStyle,
          // Anchor at fixed margins from the card edges instead of left:50%:
          // centering is handled by flex + max-width, so the pill can never
          // extend beyond its pane (no overlap with sidebar).
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'max-content',
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
          className="absolute left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 text-[11px]"
          style={{ ...pillStyle, background: 'rgba(239,68,68,0.9)', color: '#fff', border: 'none', borderRadius: 999, top: toolbarHeight + 18 }}
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

      {/* Selected info (right) — anchors below toolbar (measured), shows full
          path with start-side ellipsis, plus Copy + per-IDE Open buttons. */}
      {selected && (() => {
        const relPath = extractFilePath(selected);
        const rootClean = (root ?? '').replace(/\/+$/, '');
        const absPath = relPath
          ? (relPath.startsWith('/') ? relPath : rootClean ? `${rootClean}/${relPath}` : relPath)
          : '';
        const canOpen = isRealFileId(selected) && !!absPath;
        // Last-used IDE sorts to the front so the primary button is the one
        // the user keeps reaching for; others follow for quick switch.
        const orderedIdes = canOpen
          ? [...ides.filter((i) => i.id === lastIdeId), ...ides.filter((i) => i.id !== lastIdeId)]
          : [];
        return (
          <div
            className="absolute right-3 z-20 px-3 py-2 text-[11px] max-w-sm"
            style={{ ...pillStyle, borderRadius: 12, top: toolbarHeight + 18 }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono break-all font-semibold">{selected.label}</div>
                {relPath && (
                  // direction:rtl + unicode-bidi:plaintext keeps LTR path
                  // characters in natural order but puts the ellipsis on the
                  // left so the filename at the tail stays visible.
                  <div
                    className="mt-1 font-mono text-[10px]"
                    style={{
                      opacity: 0.75,
                      direction: 'rtl',
                      textAlign: 'left',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      unicodeBidi: 'plaintext',
                    }}
                    title={absPath || relPath}
                  >
                    {absPath || relPath}
                  </div>
                )}
                <div style={{ opacity: 0.6 }} className="mt-1 text-[10px]">
                  {selected.type} · {selected.language ?? '—'} · community {selected.community} · imp {selected.importance.toFixed(3)}
                </div>
                {relPath && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    <button
                      className="cosmos-gpu-pill-btn"
                      title="Copy full path"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(absPath || relPath);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1200);
                        } catch { /* clipboard blocked — ignore */ }
                      }}
                    >
                      {copied ? '✓ Copied' : 'Copy path'}
                    </button>
                    {canOpen && orderedIdes.map((ide) => (
                      <button
                        key={ide.id}
                        className={`cosmos-gpu-pill-btn ${ide.id === lastIdeId ? 'active' : ''}`}
                        title={`Open in ${ide.name}`}
                        onClick={async () => {
                          const api = window.electronAPI;
                          if (!api?.openInIde) return;
                          const res = await api.openInIde(ide.bundlePath, absPath);
                          if (res?.ok) {
                            setLastIdeId(ide.id);
                            try { localStorage.setItem('trace-mcp.lastIde', ide.id); } catch { /* storage blocked */ }
                          }
                        }}
                      >
                        {ide.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => setSelected(null)}
                className="cosmos-gpu-pill-btn"
                style={{ padding: '2px 6px', opacity: 0.7 }}
              >×</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
});
