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
  bottlenecks: boolean;
  stressTest: boolean;
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
  bottlenecks: false,
  stressTest: false,
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
  isArticulation?: boolean;
}
interface VizEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
  bottleneckScore?: number;
  isBridge?: boolean;
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

/**
 * Map a normalized bottleneck score [0..1] to an RGB color on a 3-stop gradient:
 * blue (#3b82f6) → amber (#f59e0b) → red (#ef4444). Returns 0..1 components.
 */
function bottleneckColor01(score: number): [number, number, number] {
  const s = Math.max(0, Math.min(1, score));
  if (s < 0.5) {
    const t = s * 2;
    return [(59 + 186 * t) / 255, (130 + 28 * t) / 255, (246 - 235 * t) / 255];
  }
  const t = (s - 0.5) * 2;
  return [(245 - 6 * t) / 255, (158 - 90 * t) / 255, (11 + 57 * t) / 255];
}

/**
 * Node color in bottleneck mode. Cold nodes drop to a dim grey so the hot
 * neighborhoods (nodes touching a high-score edge) pop as red/amber islands
 * instead of drowning in a blue fog.
 */
function bottleneckNodeColor01(score: number): [number, number, number] {
  if (score < 0.05) return [0.18, 0.20, 0.24];
  return bottleneckColor01(score);
}

/**
 * Per-node "heat": the max bottleneckScore of any adjacent edge. Lets us paint
 * nodes touching hot edges by the intensity of their hottest connection, so
 * clusters of bottlenecks read as spatial hotspots.
 */
function computeNodeBottleneckScores(nodes: VizNode[], edges: VizEdge[]): Float32Array {
  const idx = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) idx.set(nodes[i].id, i);
  const scores = new Float32Array(nodes.length);
  for (const e of edges) {
    const s = e.bottleneckScore ?? 0;
    if (s <= 0) continue;
    const si = idx.get(e.source);
    const ti = idx.get(e.target);
    if (si != null && scores[si] < s) scores[si] = s;
    if (ti != null && scores[ti] < s) scores[ti] = s;
  }
  return scores;
}

/**
 * Override link colors by bottleneckScore. Strategy: only edges that carry a
 * meaningful bottleneck signal are drawn visibly — everything else fades to
 * near-invisible atmospheric fog so the hot path reads cleanly against it.
 * Cold edges also get a desaturated grey instead of the gradient's blue
 * endpoint, so 16k routine imports don't paint the whole graph blue.
 */
function computeBottleneckLinkColors(
  linkPairs: Float32Array,
  nodes: VizNode[],
  edgeScoreByPair: Map<string, { score: number; isBridge: boolean }>,
): Float32Array {
  const numLinks = Math.floor(linkPairs.length / 2);
  const out = new Float32Array(numLinks * 4);
  for (let i = 0; i < numLinks; i++) {
    const si = linkPairs[i * 2] | 0;
    const ti = linkPairs[i * 2 + 1] | 0;
    const info = edgeScoreByPair.get(nodes[si].id + '|' + nodes[ti].id);
    const score = info?.score ?? 0;
    const isBridge = info?.isBridge === true;
    if (score < 0.05 && !isBridge) {
      out[i * 4] = 0.35;
      out[i * 4 + 1] = 0.38;
      out[i * 4 + 2] = 0.42;
      out[i * 4 + 3] = 0.015;
    } else {
      const [r, g, b] = bottleneckColor01(score);
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      const baseAlpha = 0.55 + score * 0.4;
      out[i * 4 + 3] = isBridge ? Math.max(baseAlpha, 0.95) : baseAlpha;
    }
  }
  return out;
}

function buildEdgeScoreMap(edges: VizEdge[]): Map<string, { score: number; isBridge: boolean }> {
  const map = new Map<string, { score: number; isBridge: boolean }>();
  for (const e of edges) {
    if (e.bottleneckScore == null && e.isBridge !== true) continue;
    map.set(e.source + '|' + e.target, {
      score: e.bottleneckScore ?? 0,
      isBridge: e.isBridge === true,
    });
  }
  return map;
}

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
  const labelIndicesRef = useRef<number[]>([]); // which point indices currently carry labels (also drives halo tracking subset)
  // ALL node indices sorted by importance descending. Used by the label
  // collision pass so we can pick whatever fits the current viewport
  // instead of being capped to the top-60 halo subset, which routinely
  // left zero candidates when the user zoomed into a low-importance corner.
  const nodesByImpRef = useRef<number[]>([]);
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
  // Set of indices cosmos.gl currently has selected via group-highlight or
  // "Select all N matches". cosmos.gl already greys out the rendered points,
  // but the HTML label overlay is independent — without this ref, section
  // reps and importance-ranked file labels from non-selected clusters would
  // keep rendering on top of the greyed-out cloud. null when no selection
  // filter is active; updateLabels restricts candidates to this set otherwise.
  const selectedIndicesRef = useRef<Set<number> | null>(null);
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
  // When the user clicks a specific edge row in the hotspots sidebar we also
  // remember which edge that was, so the AI prompt in the popup can describe
  // the dependency (src → tgt) rather than just the source node. Cleared on
  // node-only clicks and on Esc / clearHighlight.
  const [selectedEdge, setSelectedEdge] = useState<VizEdge | null>(null);
  // Toolbar-height tracking so popups offset past a wrapped 2-row pill.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState<number>(44);
  // Stress Test HUD measurement — both the HUD and the selected-node popup
  // anchor at top-right, so without this the popup overlaps the HUD whenever
  // Stress Test is active. We push the popup down by the HUD's real height
  // when both are visible. ResizeObserver rather than a hardcoded offset
  // because the HUD height depends on the decay curve + metrics layout.
  const stressHudRef = useRef<HTMLDivElement | null>(null);
  const [stressHudHeight, setStressHudHeight] = useState<number>(0);
  // IDE integration — populated once from main process; last-used remembered.
  const [ides, setIdes] = useState<{ id: string; name: string; bundlePath: string }[]>([]);
  const [lastIdeId, setLastIdeId] = useState<string>(() => {
    try { return localStorage.getItem('trace-mcp.lastIde') ?? ''; } catch { return ''; }
  });
  const [copied, setCopied] = useState<boolean>(false);
  const [promptCopied, setPromptCopied] = useState<boolean>(false);

  // ── Stress Test state ────────────────────────────────────────────
  // Edges the user has "broken" in Stress Test mode (keyed "source|target").
  // When non-empty, the graph re-renders without these edges so the user
  // can watch the network fragment as load-bearing connections are removed.
  const [brokenEdgeKeys, setBrokenEdgeKeys] = useState<Set<string>>(new Set());
  // Component stats for the HUD — recomputed via union-find whenever
  // brokenEdgeKeys changes. Fractions are relative to total node count.
  const [componentStats, setComponentStats] = useState<{ count: number; largestFrac: number; isolated: number }>({
    count: 1, largestFrac: 1, isolated: 0,
  });
  // Edge currently being broken — set by breakNextEdge, cleared when the
  // pre-break flash animation commits the removal. Non-null = an animation
  // is in flight; UI disables the break button to prevent rapid-fire clicks.
  const [pendingBreak, setPendingBreak] = useState<VizEdge | null>(null);
  // The last edge we flashed. Unlike pendingBreak (which clears when the
  // flash commits), this sticks around across the gap between breaks so the
  // "⚡ src → tgt" caption stays legible during a long auto-play run instead
  // of blinking on/off every cycle. Cleared only on Reset / Stress Test off.
  const [lastPendingBreak, setLastPendingBreak] = useState<VizEdge | null>(null);
  // Remaining breaks in the active auto-play sequence. 0 = not auto-playing.
  // Decrements once per scheduled break; user can stop by clicking the Stop
  // button, which sets this to 0.
  const [autoSteps, setAutoSteps] = useState<number>(0);
  // How many edges to queue up when the user clicks the Auto button. Users
  // pick from a preset list (×5 through ×100) — there's no real benefit to
  // free-form numbers, and the preset snap makes the control feel decisive.
  const [autoStepsCount, setAutoStepsCount] = useState<number>(10);
  // Decay history — one point per `brokenEdgeKeys.size` value observed. The
  // first point is "0 breaks / 100% connected" so the curve always anchors
  // at the top-left. Appended in lockstep with componentStats updates.
  const [breakHistory, setBreakHistory] = useState<Array<{ broken: number; largestFrac: number }>>([
    { broken: 0, largestFrac: 1 },
  ]);

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

  // Track Stress Test HUD height so the selected-node popup can slot in below
  // it instead of overlapping. Runs only while the HUD is mounted (stressTest
  // on); the ref becomes null when it unmounts and we reset the height to 0
  // so the popup snaps back to its normal top offset. Uses `settings.stressTest`
  // directly — destructured `stressTest` isn't declared until further down,
  // referencing it here would hit the TDZ at render time.
  useEffect(() => {
    const el = stressHudRef.current;
    if (!el) {
      if (stressHudHeight !== 0) setStressHudHeight(0);
      return;
    }
    const update = (): void => setStressHudHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [settings.stressTest, pendingBreak, brokenEdgeKeys.size, stressHudHeight]);

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

  const { scope, granularity, hideIsolated, symbolKinds, maxNodes, colorBy, showLabels, showFPS, bottlenecks, stressTest } = settings;
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

  // ── Single-edge highlight ─────────────────────────────────────
  // Pinpoint a specific bottleneck edge (source → target). Used when the
  // user clicks a sidebar row — each row IS one edge, so they expect that
  // exact edge to be highlighted, not every hot link from the source node.
  const highlightSingleEdge = useCallback((srcIdx: number, tgtIdx: number) => {
    const graph = graphRef.current;
    const data = payloadRef.current;
    const orig = origColorsRef.current;
    const linkPairs = linkPairsRef.current;
    if (!graph || !data || !orig || !linkPairs) return;

    // Source = white-hot anchor, target = hot-red (same red we use for the
    // edge itself, so the gradient reads "flow starts white, ends red").
    const colors = new Float32Array(orig);
    colors[srcIdx * 4]     = 1.0;
    colors[srcIdx * 4 + 1] = 1.0;
    colors[srcIdx * 4 + 2] = 1.0;
    colors[srcIdx * 4 + 3] = 1.0;
    colors[tgtIdx * 4]     = 1.0;
    colors[tgtIdx * 4 + 1] = 0.38;
    colors[tgtIdx * 4 + 2] = 0.38;
    colors[tgtIdx * 4 + 3] = 1.0;
    graph.setPointColors(colors);
    graph.selectPointsByIndices([srcIdx, tgtIdx]);

    // Only the specific edge is drawn; everything else goes to alpha 0.
    // Direction-agnostic match (src→tgt OR tgt→src) because cosmos.gl link
    // buffers don't guarantee the orientation we stored.
    const numLinks = Math.floor(linkPairs.length / 2);
    const linkColors = new Float32Array(numLinks * 4);
    for (let i = 0; i < numLinks; i++) {
      const s = linkPairs[i * 2] | 0;
      const t = linkPairs[i * 2 + 1] | 0;
      if ((s === srcIdx && t === tgtIdx) || (s === tgtIdx && t === srcIdx)) {
        linkColors[i * 4]     = 1.0;
        linkColors[i * 4 + 1] = 0.38;
        linkColors[i * 4 + 2] = 0.38;
        linkColors[i * 4 + 3] = 1.0;
      } else {
        linkColors[i * 4 + 3] = 0;
      }
    }
    graph.setLinkColors(linkColors);
    graph.setConfigPartial({ linkVisibilityDistanceRange: [100000, 200000] });

    const depthMap = new Map<number, number>();
    depthMap.set(srcIdx, 0);
    depthMap.set(tgtIdx, 1);
    highlightedDepthRef.current = depthMap;
    graph.render();
  }, []);

  // Focus + highlight a specific bottleneck edge from its node-id pair.
  // Fits BOTH endpoints in view so the zoom level is natural (fitting to a
  // single point zooms to the max pixel size, which is what felt "too
  // strong"). Used by the hotspots sidebar.
  const focusBottleneckEdge = useCallback((edge: VizEdge) => {
    const graph = graphRef.current;
    const indexById = indexByIdRef.current;
    if (!graph) return;
    const srcIdx = indexById.get(edge.source);
    const tgtIdx = indexById.get(edge.target);
    if (srcIdx == null || tgtIdx == null) return;
    graph.fitViewByPointIndices([srcIdx, tgtIdx], 500, 0.3);
    const node = nodesRef.current[srcIdx];
    if (node) setSelected(node);
    setSelectedEdge(edge);
    highlightSingleEdge(srcIdx, tgtIdx);
  }, [highlightSingleEdge]);

  // ── Bottleneck-only highlight (node-scoped) ────────────────────
  // Unlike highlightNeighborhood (which paints every 1-hop neighbor), this
  // shows ONLY the edges that carry a bottleneck signal from/to the seed.
  // In bottleneck mode the user cares about architectural chokepoints, not
  // routine imports — so clicking a red node should surface just the hot
  // connections that earned it that color, not its whole import fan-out.
  const highlightBottleneckEdgesFor = useCallback((seedIdx: number) => {
    const graph = graphRef.current;
    const data = payloadRef.current;
    const orig = origColorsRef.current;
    const linkPairs = linkPairsRef.current;
    if (!graph || !data || !orig || !linkPairs) return;

    const seed = data.nodes[seedIdx];
    if (!seed) return;

    const indexById = new Map<string, number>();
    for (let i = 0; i < data.nodes.length; i++) indexById.set(data.nodes[i].id, i);

    // Collect hot edges touching the seed, regardless of direction. A node
    // can be hot because of an incoming dep (many callers) or outgoing (it
    // depends on something critical) — both are relevant to the user's
    // mental model of "why is this a bottleneck?".
    const hotEdgeKeys = new Set<string>();
    const otherEnds = new Set<number>();
    for (const e of data.edges) {
      const score = e.bottleneckScore ?? 0;
      const isHot = score > 0 || e.isBridge === true;
      if (!isHot) continue;
      if (e.source === seed.id) {
        hotEdgeKeys.add(e.source + '|' + e.target);
        const ti = indexById.get(e.target);
        if (ti != null) otherEnds.add(ti);
      } else if (e.target === seed.id) {
        hotEdgeKeys.add(e.source + '|' + e.target);
        const si = indexById.get(e.source);
        if (si != null) otherEnds.add(si);
      }
    }

    // No hot edges on this node — fall back to the normal 1-hop highlight
    // so clicks still do *something*. Example: articulation-only nodes that
    // happen to have no high-score edges themselves.
    if (hotEdgeKeys.size === 0) {
      highlightNeighborhood([seedIdx]);
      return;
    }

    // Seed = bright white-hot; endpoints keep their existing heat color so
    // the gradient signal survives (red vs amber other ends still readable).
    const highlighted = [seedIdx, ...otherEnds];
    const colors = new Float32Array(orig);
    colors[seedIdx * 4]     = 1.0;
    colors[seedIdx * 4 + 1] = 1.0;
    colors[seedIdx * 4 + 2] = 1.0;
    colors[seedIdx * 4 + 3] = 1.0;
    graph.setPointColors(colors);
    graph.selectPointsByIndices(highlighted);

    // Link pass: only hot edges on this node get drawn, everything else goes
    // invisible. Alpha 0 on non-hot is OK even with linkVisibilityMinTransparency
    // — we widen the distance range below so cosmos.gl stops fading anything.
    const numLinks = Math.floor(linkPairs.length / 2);
    const linkColors = new Float32Array(numLinks * 4);
    for (let i = 0; i < numLinks; i++) {
      const s = linkPairs[i * 2] | 0;
      const t = linkPairs[i * 2 + 1] | 0;
      const srcId = data.nodes[s]?.id;
      const tgtId = data.nodes[t]?.id;
      if (srcId == null || tgtId == null) continue;
      if (hotEdgeKeys.has(srcId + '|' + tgtId)) {
        linkColors[i * 4]     = 1.0;
        linkColors[i * 4 + 1] = 0.38;
        linkColors[i * 4 + 2] = 0.38;
        linkColors[i * 4 + 3] = 1.0;
      } else {
        linkColors[i * 4 + 3] = 0;
      }
    }
    graph.setLinkColors(linkColors);
    graph.setConfigPartial({ linkVisibilityDistanceRange: [100000, 200000] });

    // Same bookkeeping clearHighlight reads — ensures Esc restores correctly.
    const depthMap = new Map<number, number>();
    depthMap.set(seedIdx, 0);
    for (const idx of otherEnds) depthMap.set(idx, 1);
    highlightedDepthRef.current = depthMap;
    graph.render();
  }, []);

  // ── focusNode (for imperative handle) ─────────────────────────
  const focusNode = useCallback((id: string) => {
    const graph = graphRef.current;
    const idx = indexByIdRef.current.get(id);
    if (!graph || idx == null) return;
    graph.fitViewByPointIndices([idx], 500, 0.3);
    const node = nodesRef.current[idx];
    if (node) setSelected(node);
    setSelectedEdge(null);
    // In bottleneck mode, show only the hot edges of this node. Otherwise
    // fall back to the normal 1-hop BFS neighborhood highlight.
    if (settings.bottlenecks || settings.stressTest) {
      highlightBottleneckEdgesFor(idx);
    } else {
      highlightNeighborhood([idx]);
    }
  }, [settings.bottlenecks, settings.stressTest, highlightBottleneckEdgesFor]);
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
    graph.setConfigPartial({ linkVisibilityDistanceRange: [100000, 200000] });
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
    graph.setConfigPartial({ linkVisibilityDistanceRange: [100, 400] });
    graph.render();
    highlightedDepthRef.current = null;
    selectedIndicesRef.current = null;
    setSelected(null);
    setSelectedEdge(null);
  }, [themeSpec]);

  // Mode-aware highlight picker used by the cosmos.gl onClick callback.
  // That callback is captured once at Graph() construction and can't see
  // `settings` directly without rebuilding the instance on every toggle —
  // so we funnel through a ref that's re-pointed whenever the mode flips.
  const highlightByModeRef = useRef<(idx: number) => void>(() => {});
  useEffect(() => {
    highlightByModeRef.current = (idx: number) => {
      if (settings.bottlenecks || settings.stressTest) {
        highlightBottleneckEdgesFor(idx);
      } else {
        highlightNeighborhood([idx]);
      }
    };
  }, [settings.bottlenecks, settings.stressTest, highlightBottleneckEdgesFor, highlightNeighborhood]);

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
    // Read positions ONCE per frame — getPointPositions() copies a buffer
    // from WebGL to JS; calling it inside the loop cost us N×50 copies per
    // frame when displaying 50 labels. Now: one copy, used by both the
    // index-selection pass and the per-label transform writes.
    const positions = graph.getPointPositions();
    // Unified label-placement pass: prioritise hovered/selected → highlight
    // subgraph (if active) → section reps → all nodes by importance, with
    // viewport culling and screen-space collision detection. Replaces the
    // old zoom-tier branches, which fell apart when the actual cosmos zoom
    // value didn't match what the user perceived as "zoom-out" (e.g. a
    // small cluster fitted to a large canvas reports zoom ≥ 2 and dropped
    // straight into the top-N file branch, hiding section headings).
    const indices = new Set<number>();
    const highlightedDepth = highlightedDepthRef.current;
    const highlightActive = highlightedDepth != null && highlightedDepth.size > 0;
    const cw = containerRef.current?.clientWidth ?? 0;
    const ch = containerRef.current?.clientHeight ?? 0;
    // Collision rectangle around each placed label. Approximates a typical
    // 6–10 char label rendered at the overlay's ~11px / 13px line-height;
    // tighter values let labels stack into an unreadable mush at zoom-out.
    const HCLEAR = 70;
    const VCLEAR = 16;
    const HARD_CAP = 80;
    const placed: Array<{ x: number; y: number }> = [];
    const screenOf = (idx: number): [number, number] | null => {
      const sx = positions[idx * 2];
      const sy = positions[idx * 2 + 1];
      if (!Number.isFinite(sx)) return null;
      return graph.spaceToScreenPosition([sx, sy]) as [number, number];
    };
    const collides = (x: number, y: number) => {
      for (const p of placed) {
        if (Math.abs(p.x - x) < HCLEAR && Math.abs(p.y - y) < VCLEAR) return true;
      }
      return false;
    };
    const tryPlace = (idx: number, allowOffscreen = false, allowOverlap = false): boolean => {
      if (indices.has(idx) || indices.size >= HARD_CAP) return false;
      const s = screenOf(idx);
      if (!s) return false;
      const [px, py] = s;
      if (!allowOffscreen && (px < 0 || px > cw || py < 0 || py > ch)) return false;
      if (!allowOverlap && collides(px, py)) return false;
      placed.push({ x: px, y: py });
      indices.add(idx);
      return true;
    };
    if (showLabels) {
      if (zoom >= 0.5) {
        // Hovered/selected: always shown, ignoring overlap — the user is
        // explicitly interrogating these and expects to see the name.
        if (hovered) {
          const i = indexByIdRef.current.get(hovered.id);
          if (i != null) tryPlace(i, true, true);
        }
        if (selected) {
          const i = indexByIdRef.current.get(selected.id);
          if (i != null) tryPlace(i, true, true);
        }
        if (highlightActive) {
          // Highlight subgraph: rank seed + 1-hop neighbours by importance,
          // place with collision so a hub click doesn't paint a wall of
          // overlapping filenames over the connected neighbourhood.
          const ranked: number[] = [];
          for (const [idx, d] of highlightedDepth) {
            if (d <= 1) ranked.push(idx);
          }
          ranked.sort((a, b) => (nodes[b]?.importance ?? 0) - (nodes[a]?.importance ?? 0));
          for (const idx of ranked) tryPlace(idx);
        } else {
          // When a group/search selection filter is active, restrict label
          // candidates to the selected set — otherwise non-selected clusters
          // keep their section headers and importance-ranked file labels
          // floating over the greyed-out cloud.
          const selectedSet = selectedIndicesRef.current;
          // Sections first — community headings dominate the zoomed-out view.
          // We always TRY all sections; collision drops the ones whose reps
          // overlap each other in a tight cluster (extreme zoom-out → 1-2
          // survive; fit → ~all 8 survive).
          for (const idx of sectionIndicesRef.current) {
            if (!sectionLabelByIndexRef.current.has(idx)) continue;
            if (selectedSet && !selectedSet.has(idx)) continue;
            tryPlace(idx);
          }
          // File labels live on a zoom-scaled budget. At fit (~zoom 6) the
          // budget is 0 → only sections survive, matching the user's mental
          // model that fit = "show me the map, not the streets". The slope
          // is intentionally gentle (~3 slots per zoom level) so the next
          // zoom step after fit reveals only the *most* important files,
          // not a wall of medium-importance hubs. HARD_CAP is hit naturally
          // around zoom ≈ 30, by which point the user is reading individual
          // identifiers anyway.
          const fileBudget = Math.max(0, Math.floor((zoom - 6) * 3));
          let fileAdded = 0;
          for (const idx of nodesByImpRef.current) {
            if (fileAdded >= fileBudget) break;
            if (sectionLabelByIndexRef.current.has(idx)) continue;
            if (selectedSet && !selectedSet.has(idx)) continue;
            if (tryPlace(idx)) fileAdded++;
          }
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
    if (settings.bottlenecks || settings.stressTest) params.set('includeBottlenecks', 'true');

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
  }, [root, scope, granularity, hideIsolated, debouncedSymbolKinds, debouncedMaxNodes, settings.bottlenecks, settings.stressTest]);

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
        pointDefaultSize: adaptivePointSize,
        linkDefaultWidth: adaptiveLinkWidth,
        linkDefaultArrows: adaptiveLinkArrows,
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
          setSelectedEdge(null);
          // Route through the mode-aware highlight picker. Bottleneck mode
          // shows only hot adjacent edges; normal mode shows the full 1-hop
          // neighborhood. The ref avoids rebuilding the Graph() instance
          // every time the mode flips — cosmos.gl resolves it lazily here.
          highlightByModeRef.current(index);
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
    // In bottleneck mode: articulation points get bright red, other nodes are
    // painted by the max bottleneckScore of their adjacent edges — so hot
    // neighborhoods glow while cold parts of the graph fade to dim grey.
    const useBottleneckColors = settings.bottlenecks || settings.stressTest;
    const nodeScores = useBottleneckColors
      ? computeNodeBottleneckScores(nodes, data.edges)
      : null;
    const colors = new Float32Array(nodes.length * 4);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (useBottleneckColors && n.isArticulation) {
        colors[i * 4] = 0.937;     // #ef4444
        colors[i * 4 + 1] = 0.267;
        colors[i * 4 + 2] = 0.267;
      } else if (useBottleneckColors && nodeScores) {
        const [r, g, b] = bottleneckNodeColor01(nodeScores[i]);
        colors[i * 4] = r;
        colors[i * 4 + 1] = g;
        colors[i * 4 + 2] = b;
      } else {
        const [r, g, b] = nodeColor01(n, colorBy, commColors);
        colors[i * 4] = r;
        colors[i * 4 + 1] = g;
        colors[i * 4 + 2] = b;
      }
      colors[i * 4 + 3] = 1;
    }

    // Sizes — articulation points get a +60% bump so they're visually larger than normal nodes.
    const sizes = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const base = nodeSize(nodes[i]);
      sizes[i] = useBottleneckColors && nodes[i].isArticulation ? base * 1.6 : base;
    }

    // Top-N important nodes for label overlay defaults
    const topByImp = [...nodes.keys()].sort(
      (a, b) => (nodes[b].importance ?? 0) - (nodes[a].importance ?? 0),
    );
    // labelIndicesRef stays capped — it's the halo-tracking subset (each
    // tracked index costs a per-tick GPU→CPU copy in trackedPositionsFbo).
    // nodesByImpRef holds the full ranking so the label collision pass
    // can keep walking when the top 60 are all off-screen.
    labelIndicesRef.current = topByImp.slice(0, 60);
    nodesByImpRef.current = topByImp;

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

    // Snapshot so highlightNeighborhood can rewrite colors per hop-distance
    // and clearHighlight can restore them. Copy because `colors` is reused
    // by the GPU buffer.
    origColorsRef.current = new Float32Array(colors);

    // cosmos.gl 3.0 made device/canvas init asynchronous. Data-setters
    // invoked before `graph.ready` resolves silently no-op, leaving the
    // canvas empty. Gate every initial data push on the ready promise.
    // See cosmos.gl v3 notes: `readonly ready: Promise<void>` + `isReady`.
    const applyPointData = () => {
      // Push the point data immediately — user sees nodes even before edges
      // finish processing on big graphs.
      graph.setPointPositions(positions);
      graph.setPointColors(colors);
      graph.setPointSizes(sizes);
      // Register the subset the halo pass wants. cosmos.gl then runs a
      // per-tick GPU copy of just these indices into trackedPositionsFbo,
      // which the halo pass reads via getTrackedPointPositionsMap(). The
      // subset is re-registered on every renderGraph cycle because
      // labelIndicesRef is rebuilt from the new nodes array.
      graph.trackPointPositionsByIndices(labelIndicesRef.current);
      // Cap the opening alpha — per-tick forces `delta = alpha × force`
      // would otherwise be at full magnitude and close-pair repulsion
      // spikes make individual points visibly pop.
      graph.start(0.4);
    };
    if (graph.isReady) applyPointData();
    else graph.ready.then(applyPointData).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[graph] init ready failed', err);
    });

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
      // Re-gate: a small worker job may still return before cosmos.gl's
      // async device init has resolved. setLinks before ready is a no-op
      // (same silent failure as the point-data path above).
      if (!g.isReady) {
        g.ready.then(() => finalize(links)).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[graph] finalize ready failed', err);
        });
        return;
      }
      try {
        g.setLinks(links);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[graph] setLinks failed', err);
        setError('setLinks: ' + decorateErr(err).message);
        return;
      }
      // Cache pairs so highlightNeighborhood can rewrite per-link colors for
      // the 1-hop subgraph. Copy because cosmos.gl may retain the underlying
      // buffer for GPU upload.
      linkPairsRef.current = new Float32Array(links);
      // Compute & push per-link tints (shade of source node's color). Falls
      // back silently to linkDefaultColor if point colors aren't ready yet.
      // When bottleneck mode is active, colors come from the bottleneck
      // palette instead (blue → amber → red by score) so hot-path edges
      // read immediately even in dense clusters.
      const srcPointColors = origColorsRef.current;
      if (srcPointColors) {
        const useBottleneck = settings.bottlenecks || settings.stressTest;
        const linkColors = useBottleneck
          ? computeBottleneckLinkColors(linkPairsRef.current, nodes, buildEdgeScoreMap(data.edges))
          : computeTintedLinkColors(
              srcPointColors,
              linkPairsRef.current,
              hexToRgb01(themeSpec.background),
              LINK_TINT_MIX,
              LINK_TINT_ALPHA,
            );
        defaultLinkColorsRef.current = linkColors;
        try {
          g.setLinkColors(new Float32Array(linkColors));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[graph] setLinkColors failed', err);
          setError('setLinkColors: ' + decorateErr(err).message);
          return;
        }
      }
      // cosmos.gl auto-starts the simulation on new Graph() when
      // enableSimulation is true (default). No manual start() needed.
      // A redundant render() call wakes the draw loop after setLinks.
      try {
        g.render();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[graph] render failed', err);
        setError('render: ' + decorateErr(err).message);
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
  }, [themeSpec, colorBy, showFPS, settings.bottlenecks, settings.stressTest]);

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
    const useBottleneckColors = settings.bottlenecks || settings.stressTest;
    const commColors = new Map<number, string>();
    for (const c of data.communities) commColors.set(c.id, c.color);
    const nodeScores = useBottleneckColors
      ? computeNodeBottleneckScores(data.nodes, data.edges)
      : null;
    const colors = new Float32Array(data.nodes.length * 4);
    for (let i = 0; i < data.nodes.length; i++) {
      const n = data.nodes[i];
      if (useBottleneckColors && n.isArticulation) {
        colors[i * 4] = 0.937;
        colors[i * 4 + 1] = 0.267;
        colors[i * 4 + 2] = 0.267;
      } else if (useBottleneckColors && nodeScores) {
        const [r, g, b] = bottleneckNodeColor01(nodeScores[i]);
        colors[i * 4] = r;
        colors[i * 4 + 1] = g;
        colors[i * 4 + 2] = b;
      } else {
        const [r, g, b] = nodeColor01(n, colorBy, commColors);
        colors[i * 4] = r;
        colors[i * 4 + 1] = g;
        colors[i * 4 + 2] = b;
      }
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
      const linkColors = useBottleneckColors
        ? computeBottleneckLinkColors(linkPairs, data.nodes, buildEdgeScoreMap(data.edges))
        : computeTintedLinkColors(
            colors,
            linkPairs,
            hexToRgb01(themeSpec.background),
            LINK_TINT_MIX,
            LINK_TINT_ALPHA,
          );
      defaultLinkColorsRef.current = linkColors;
      graph.setLinkColors(new Float32Array(linkColors));
    }
    graph.render();
  }, [colorBy, settings.bottlenecks, settings.stressTest]);

  // ── Theme change → update config live ─────────────────────────
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    // Bottleneck mode draws thicker links so the ~50-100 hot edges read over
    // the ~16k near-transparent cold ones. Fog width doesn't matter (alpha
    // ≈ 0.015 is invisible regardless of thickness). Outside bottleneck mode
    // we revert to the adaptive width picked at construction time.
    const nCount = payloadRef.current?.nodes.length ?? 0;
    const bigGraph = nCount > 3000;
    const hugeGraph = nCount > 8000;
    const baseWidth = hugeGraph ? 0.5 : bigGraph ? 0.7 : 0.9;
    const bottleneckActive = settings.bottlenecks || settings.stressTest;
    graph.setConfigPartial({
      backgroundColor: themeSpec.background,
      linkDefaultColor: themeSpec.linkColor,
      pointDefaultColor: themeSpec.pointDefaultColor,
      hoveredLinkColor: themeSpec.hoveredLink,
      hoveredPointRingColor: themeSpec.hoveredLink,
      linkDefaultWidth: bottleneckActive ? baseWidth * 2.2 : baseWidth,
    });
    // Tints lerp toward background, so background change ⇒ recompute tints.
    // Bottleneck mode uses a theme-independent palette, so we skip the recompute.
    const pointColors = origColorsRef.current;
    const linkPairs = linkPairsRef.current;
    const data = payloadRef.current;
    const useBottleneckColors = (settings.bottlenecks || settings.stressTest) && data != null;
    if (pointColors && linkPairs && linkPairs.length >= 2) {
      const linkColors = useBottleneckColors && data
        ? computeBottleneckLinkColors(linkPairs, data.nodes, buildEdgeScoreMap(data.edges))
        : computeTintedLinkColors(
            pointColors,
            linkPairs,
            hexToRgb01(themeSpec.background),
            LINK_TINT_MIX,
            LINK_TINT_ALPHA,
          );
      defaultLinkColorsRef.current = linkColors;
      graph.setLinkColors(new Float32Array(linkColors));
    }
    graph.render();
  }, [themeSpec, settings.bottlenecks, settings.stressTest]);

  // ── Stress Test: break next edge, reset, and recompute components ──────
  // Edge keys are "source|target" — same format used in buildEdgeScoreMap.
  // "Break next" picks the highest-bottleneckScore edge not yet in the set.
  // Instead of committing the removal directly, we stage it in `pendingBreak`
  // so the flash-animation effect can highlight the victim edge for ~450 ms
  // before it disappears — turning each step into a visible event the user
  // can track on the graph.
  const breakNextEdge = useCallback(() => {
    const data = payloadRef.current;
    if (!data) return;
    let best: VizEdge | null = null;
    let bestScore = -1;
    for (const e of data.edges) {
      const k = e.source + '|' + e.target;
      if (brokenEdgeKeys.has(k)) continue;
      const s = e.bottleneckScore ?? 0;
      if (s > bestScore) { bestScore = s; best = e; }
    }
    if (!best || bestScore <= 0) {
      // No hot edges left — stop any auto-play sequence in flight so the
      // button flips back to Break/Auto immediately instead of a dead loop.
      setAutoSteps(0);
      return;
    }
    setPendingBreak(best);
    setLastPendingBreak(best);
  }, [brokenEdgeKeys]);

  const resetStressTest = useCallback(() => {
    setBrokenEdgeKeys(new Set());
    setAutoSteps(0);
    setPendingBreak(null);
    setLastPendingBreak(null);
    setBreakHistory([{ broken: 0, largestFrac: 1 }]);
  }, []);

  // Auto-reset the broken set when Stress Test turns off so toggling back on
  // starts from a clean slate instead of showing a half-destroyed graph.
  useEffect(() => {
    if (!stressTest) {
      if (brokenEdgeKeys.size > 0) setBrokenEdgeKeys(new Set());
      if (autoSteps > 0) setAutoSteps(0);
      if (pendingBreak) setPendingBreak(null);
      if (lastPendingBreak) setLastPendingBreak(null);
      if (breakHistory.length > 1) setBreakHistory([{ broken: 0, largestFrac: 1 }]);
    }
  }, [stressTest, brokenEdgeKeys.size, autoSteps, pendingBreak, lastPendingBreak, breakHistory.length]);

  // Pacing refs — read at effect start so the flash/gap timers pick up the
  // user's current Auto ×N choice without re-running the effect on every
  // setState (which would cancel the in-flight timer).
  const autoStepsRef = useRef(autoSteps);
  autoStepsRef.current = autoSteps;
  const autoStepsCountRef = useRef(autoStepsCount);
  autoStepsCountRef.current = autoStepsCount;

  // Flash animation: highlight the victim edge in hot white for ~450 ms,
  // then commit the removal. Runs whenever pendingBreak is set. Uses the
  // cached defaultLinkColorsRef as a baseline so the rest of the graph
  // keeps its bottleneck-mode palette during the flash.
  useEffect(() => {
    if (!pendingBreak) return;
    const graph = graphRef.current;
    const linkPairs = linkPairsRef.current;
    const data = payloadRef.current;
    const defaults = defaultLinkColorsRef.current;
    if (!graph || !linkPairs || !data || !defaults) {
      setPendingBreak(null);
      return;
    }
    const indexById = new Map<string, number>();
    for (let i = 0; i < data.nodes.length; i++) indexById.set(data.nodes[i].id, i);
    const si = indexById.get(pendingBreak.source);
    const ti = indexById.get(pendingBreak.target);
    const flash = new Float32Array(defaults);
    if (si != null && ti != null) {
      const numLinks = Math.floor(linkPairs.length / 2);
      for (let i = 0; i < numLinks; i++) {
        const s = linkPairs[i * 2] | 0;
        const t = linkPairs[i * 2 + 1] | 0;
        if ((s === si && t === ti) || (s === ti && t === si)) {
          flash[i * 4]     = 1.0;
          flash[i * 4 + 1] = 0.96;
          flash[i * 4 + 2] = 0.72;
          flash[i * 4 + 3] = 1.0;
        }
      }
      try {
        graph.setLinkColors(flash);
        graph.render();
      } catch { /* setLinkColors race with re-render — let commit retry */ }
    }
    // Pacing: single breaks (or small auto runs ≤10) hold the flash long
    // enough for the eye to catch it. Large runs (×100) compress times so
    // the whole sequence doesn't drag into 70+ seconds of tedium.
    const autoTarget = autoStepsRef.current > 0 ? autoStepsCountRef.current : 0;
    const speed = autoTarget > 0
      ? Math.max(0.4, Math.min(1.0, 10 / autoTarget))
      : 1.0;
    const flashMs = Math.round(450 * speed);
    const timer = window.setTimeout(() => {
      const key = pendingBreak.source + '|' + pendingBreak.target;
      setBrokenEdgeKeys((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setPendingBreak(null);
    }, flashMs);
    return () => window.clearTimeout(timer);
  }, [pendingBreak]);

  // Auto-play: schedule the next break after the current one finishes
  // animating. Decrement autoSteps each time we kick off a break; when it
  // hits 0 (or the edge pool dries up) the sequence ends naturally. Gap
  // shrinks with the run size so ×100 completes in ~30 s instead of 70+.
  const breakNextEdgeRef = useRef(breakNextEdge);
  breakNextEdgeRef.current = breakNextEdge;
  useEffect(() => {
    if (autoSteps <= 0) return;
    if (pendingBreak) return;
    const speed = Math.max(0.4, Math.min(1.0, 10 / autoStepsCountRef.current));
    const gapMs = Math.round(280 * speed);
    const timer = window.setTimeout(() => {
      setAutoSteps((n) => Math.max(0, n - 1));
      breakNextEdgeRef.current();
    }, gapMs);
    return () => window.clearTimeout(timer);
  }, [autoSteps, pendingBreak, brokenEdgeKeys.size]);

  // History tracker: append one point per unique brokenEdgeKeys.size value,
  // update the last point in place when componentStats shifts for the same
  // size (the union-find effect resets stats before we land here).
  useEffect(() => {
    if (!stressTest) return;
    setBreakHistory((prev) => {
      const last = prev[prev.length - 1];
      const point = { broken: brokenEdgeKeys.size, largestFrac: componentStats.largestFrac };
      if (last && last.broken === point.broken) {
        if (last.largestFrac === point.largestFrac) return prev;
        const next = prev.slice(0, -1);
        next.push(point);
        return next;
      }
      return [...prev, point];
    });
  }, [brokenEdgeKeys.size, componentStats.largestFrac, stressTest]);

  // Rebuild link buffer excluding broken edges + recompute component stats.
  // Uses a union-find pass — O(E α(V)) which is effectively linear.
  useEffect(() => {
    const graph = graphRef.current;
    const data = payloadRef.current;
    if (!graph || !data || !stressTest) return;

    const indexById = new Map<string, number>();
    for (let i = 0; i < data.nodes.length; i++) indexById.set(data.nodes[i].id, i);

    // Walk edges once; produce (a) the filtered link buffer for cosmos.gl,
    // (b) a surviving-edge list so node-heat recomputation reflects the
    // post-break graph (a node whose hot edges were all removed fades to
    // dim grey instead of staying red). Without this, breaks feel inert:
    // edges disappear but the heat map stays frozen.
    const pairs: number[] = [];
    const survivingEdges: VizEdge[] = [];
    for (const e of data.edges) {
      if (brokenEdgeKeys.has(e.source + '|' + e.target)) continue;
      const s = indexById.get(e.source);
      const t = indexById.get(e.target);
      if (s == null || t == null) continue;
      pairs.push(s, t);
      survivingEdges.push(e);
    }
    const links = new Float32Array(pairs);
    linkPairsRef.current = links;
    try {
      graph.setLinks(links);
      const edgeScoreMap = buildEdgeScoreMap(survivingEdges);
      const linkColors = computeBottleneckLinkColors(links, data.nodes, edgeScoreMap);
      defaultLinkColorsRef.current = linkColors;
      graph.setLinkColors(new Float32Array(linkColors));

      // Rebuild point colors against surviving edges so node heat drops as
      // their hot adjacencies vanish. Articulation flags stay as-is (they're
      // a property of the original graph, not the damaged one).
      const commColors = new Map<number, string>();
      for (const c of data.communities) commColors.set(c.id, c.color);
      const nodeScores = computeNodeBottleneckScores(data.nodes, survivingEdges);
      const colors = new Float32Array(data.nodes.length * 4);
      for (let i = 0; i < data.nodes.length; i++) {
        const n = data.nodes[i];
        if (n.isArticulation) {
          colors[i * 4]     = 0.937;
          colors[i * 4 + 1] = 0.267;
          colors[i * 4 + 2] = 0.267;
        } else {
          const [r, g, b] = bottleneckNodeColor01(nodeScores[i]);
          colors[i * 4]     = r;
          colors[i * 4 + 1] = g;
          colors[i * 4 + 2] = b;
        }
        colors[i * 4 + 3] = 1;
      }
      graph.setPointColors(colors);
      origColorsRef.current = new Float32Array(colors);
      graph.render();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[stress-test] setLinks failed', err);
      return;
    }

    // Union-find over undirected remaining edges
    const n = data.nodes.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    for (let i = 0; i < pairs.length; i += 2) {
      const a = pairs[i];
      const b = pairs[i + 1];
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
    const sizeByRoot = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      sizeByRoot.set(r, (sizeByRoot.get(r) ?? 0) + 1);
    }
    let largest = 0;
    let isolated = 0;
    for (const s of sizeByRoot.values()) {
      if (s > largest) largest = s;
      if (s === 1) isolated++;
    }
    setComponentStats({
      count: sizeByRoot.size,
      largestFrac: n > 0 ? largest / n : 0,
      isolated,
    });
  }, [brokenEdgeKeys, stressTest]);

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

  // Build an AI prompt for the current bottleneck selection.
  // - If an edge is selected (sidebar click): edge-oriented prompt describing
  //   the specific dependency src → tgt with its score and rank.
  // - Else if a node is selected: node-oriented prompt listing the node's
  //   hot adjacencies, same as before.
  // Returns an empty string when there's no bottleneck signal to analyse —
  // caller uses that to decide whether to render the AI PROMPT block.
  const buildBottleneckPrompt = useCallback(
    (node: VizNode, edge: VizEdge | null): string => {
      const data = payloadRef.current;
      if (!data) return '';
      const rootClean = (root ?? '').replace(/\/+$/, '');
      const toAbs = (id: string): string =>
        id.startsWith('/') ? id : rootClean ? `${rootClean}/${id}` : id;

      // Project-wide edge ranking used for "rank #N" label (score-sorted).
      const rankedEdges = [...data.edges]
        .filter((e) => (e.bottleneckScore ?? 0) > 0)
        .sort((a, b) => (b.bottleneckScore ?? 0) - (a.bottleneckScore ?? 0));

      // ── Edge-scoped prompt ──────────────────────────────────────────
      if (edge) {
        const score = edge.bottleneckScore ?? 0;
        const isBridge = edge.isBridge === true;
        if (score <= 0 && !isBridge) return '';

        const rank = rankedEdges.findIndex(
          (e) => e.source === edge.source && e.target === edge.target,
        );
        const srcAbs = toAbs(edge.source);
        const tgtAbs = toAbs(edge.target);

        const lines: string[] = [];
        lines.push(`Analyze a specific architectural bottleneck dependency.`);
        lines.push(``);
        lines.push(`Source: ${srcAbs}`);
        lines.push(`Target: ${tgtAbs}`);
        lines.push(
          `Bottleneck score: ${score.toFixed(2)}${rank >= 0 ? ` (rank #${rank + 1} among all edges in the project)` : ''}`,
        );
        if (isBridge) {
          lines.push(
            `Bridge: removing this single edge would disconnect the graph into separate components.`,
          );
        }
        lines.push(``);
        lines.push(`Tasks:`);
        lines.push(
          `1. Open both files. Explain in 2–3 bullets WHAT the source imports/uses from the target and WHY.`,
        );
        lines.push(
          `2. Assess whether this dependency is essential or accidental. Specifically: does the source need the target's concrete implementation, or would an interface / narrower API suffice?`,
        );
        lines.push(
          `3. Propose 2–3 options to weaken or eliminate this edge: dependency inversion via interface, moving the shared concern to a third module, inlining the imported piece, or replacing with an event/queue. For each, predict the effect on the bottleneck score and the churn cost.`,
        );
        lines.push(
          `4. If this edge is a BRIDGE, explicitly flag the risk: current architecture has no alternative path between these clusters, so breaking it isolates part of the codebase.`,
        );
        lines.push(``);
        lines.push(
          `Context: bottleneck score = normalized edge betweenness × (1 + normalized co-change weight). A score near 1.0 means the vast majority of shortest dependency paths in the project pass through this one edge, AND the two files change together frequently in git history — both signals of a fragile architectural coupling.`,
        );
        return lines.join('\n');
      }

      // ── Node-scoped prompt (no specific edge) ──────────────────────
      const absPath = toAbs(node.id);

      type HotEdge = { other: string; score: number; isBridge: boolean; direction: 'out' | 'in' };
      const hotEdges: HotEdge[] = [];
      for (const e of data.edges) {
        const score = e.bottleneckScore ?? 0;
        const isHot = score > 0 || e.isBridge === true;
        if (!isHot) continue;
        if (e.source === node.id)
          hotEdges.push({ other: e.target, score, isBridge: e.isBridge === true, direction: 'out' });
        else if (e.target === node.id)
          hotEdges.push({ other: e.source, score, isBridge: e.isBridge === true, direction: 'in' });
      }
      hotEdges.sort((a, b) => b.score - a.score);

      if (hotEdges.length === 0 && !node.isArticulation) return '';

      const maxScore = hotEdges[0]?.score ?? 0;
      const rank = rankedEdges.findIndex(
        (e) => e.source === node.id || e.target === node.id,
      );

      const lines: string[] = [];
      lines.push(`Analyze an architectural bottleneck at this location.`);
      lines.push(``);
      lines.push(`File: ${absPath}`);
      lines.push(
        `Top bottleneck score: ${maxScore.toFixed(2)}${rank >= 0 ? ` (rank #${rank + 1} among all edges in the project)` : ''}`,
      );
      if (node.isArticulation) {
        lines.push(
          `Articulation point: removing this file from the import graph would split the graph into multiple disconnected components.`,
        );
      }
      if (hotEdges.length > 0) {
        lines.push(``);
        lines.push(`Critical dependencies (high bottleneck score):`);
        for (const e of hotEdges.slice(0, 10)) {
          const arrow = e.direction === 'out' ? '→' : '←';
          const bridge = e.isBridge ? ' [BRIDGE — removing this edge alone disconnects the graph]' : '';
          lines.push(`  ${arrow} ${e.other} (score ${e.score.toFixed(2)}${bridge})`);
        }
      }
      lines.push(``);
      lines.push(`Tasks:`);
      lines.push(`1. Read this file and summarise its current responsibilities in 3–5 bullets.`);
      lines.push(`2. Investigate why it has such high coupling. Is it a god-module? A leaky abstraction? A registry/bus that collects too much?`);
      lines.push(`3. Propose 2–3 concrete refactoring options with trade-offs. For each, predict the impact on the bottleneck score.`);
      lines.push(`4. For each critical dependency above, classify it as: (a) invertible via interface, (b) extractable into a shared module, (c) mediatable via an event/queue, or (d) genuinely essential. Justify each call.`);
      lines.push(``);
      lines.push(`Context: bottleneck score = normalized edge betweenness × (1 + normalized co-change weight), computed over the import graph. High score means many shortest dependency paths cross this node AND it changes together with its neighbours in git history — a double signal for architectural fragility.`);
      return lines.join('\n');
    },
    [root],
  );

  // Top hotspot edges for the bottleneck sidebar. Depends on `stats` (set after
  // each fetch) so toggling modes — which retriggers loadGraph and repopulates
  // payloadRef.current.edges with bottleneckScore — recomputes the list.
  const topBottlenecks = useMemo(() => {
    const data = payloadRef.current;
    if (!data) return [] as VizEdge[];
    if (!(settings.bottlenecks || settings.stressTest)) return [] as VizEdge[];
    return [...data.edges]
      .filter((e) => (e.bottleneckScore ?? 0) > 0 || e.isBridge === true)
      .sort((a, b) => (b.bottleneckScore ?? 0) - (a.bottleneckScore ?? 0))
      .slice(0, 20);
  }, [stats, settings.bottlenecks, settings.stressTest]);

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
    // Wipe any active click-highlight (BFS colors, depth map, widened link
    // fade) before overlaying the group/search selection — otherwise the
    // previous click's subgraph labels and tinted edges stick around on top
    // of the new cosmos.gl selection.
    if (highlightedDepthRef.current) clearHighlight();
    graph.selectPointsByIndices(Array.from(visited));
    selectedIndicesRef.current = new Set(visited);
    setSearchQuery('');
  }, [searchQuery, clearHighlight]);

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
    // Wipe any active click-highlight (BFS colors, depth map, widened link
    // fade) before overlaying the group selection — see doSelectAllMatches.
    if (highlightedDepthRef.current) clearHighlight();
    graph.selectPointsByIndices(indices);
    selectedIndicesRef.current = new Set(indices);
  }, [clearHighlight]);

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

      {/* Bottleneck hotspots panel — legend + Top-20 edges with click-to-focus.
          Anchored top-left so it doesn't collide with the Stress Test HUD or
          the selected-node popup on the right. Only shown when the bottleneck
          layer is active (Bottlenecks or Stress Test pill). */}
      {(bottlenecks || stressTest) && topBottlenecks.length > 0 && (
        <div
          className="absolute left-3 z-30 px-3 py-2.5"
          style={{
            ...pillStyle,
            top: toolbarHeight + 18,
            width: 280,
            fontFamily: sysFont,
            maxHeight: `calc(100% - ${toolbarHeight + 36}px)`,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            className="text-[10px] uppercase tracking-wider mb-1.5"
            style={{ opacity: 0.6, letterSpacing: '0.08em' }}
          >
            Bottleneck score
          </div>
          <div
            style={{
              height: 7,
              borderRadius: 4,
              background: 'linear-gradient(to right, #3b82f6, #f59e0b, #ef4444)',
            }}
          />
          <div
            className="flex justify-between text-[10px] mb-3 mt-1"
            style={{ opacity: 0.55, fontVariantNumeric: 'tabular-nums' }}
          >
            <span>low</span>
            <span style={{ color: '#ef4444' }}>● articulation point</span>
            <span>high</span>
          </div>

          <div
            className="text-[10px] uppercase tracking-wider mb-1.5"
            style={{ opacity: 0.6, letterSpacing: '0.08em' }}
          >
            Top {topBottlenecks.length} hotspots
          </div>
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, marginRight: -6, paddingRight: 6 }}>
            {topBottlenecks.map((e, i) => {
              const score = e.bottleneckScore ?? 0;
              const [r, g, b] = bottleneckColor01(score);
              const dotRgb = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
              const srcShort = e.source.split('/').pop() ?? e.source;
              const tgtShort = e.target.split('/').pop() ?? e.target;
              return (
                <button
                  key={`${e.source}|${e.target}|${i}`}
                  onClick={() => focusBottleneckEdge(e)}
                  className="cosmos-gpu-bn-row"
                  title={`${e.source} → ${e.target}\nScore ${score.toFixed(3)}${e.isBridge ? ' (bridge)' : ''}`}
                >
                  <div className="cosmos-gpu-bn-row-top">
                    <span
                      className="cosmos-gpu-bn-dot"
                      style={{ background: dotRgb }}
                    />
                    <span className="cosmos-gpu-bn-name">{srcShort}</span>
                    {e.isBridge && <span className="cosmos-gpu-bn-bridge">BR</span>}
                    <span className="cosmos-gpu-bn-score">{score.toFixed(2)}</span>
                  </div>
                  <div className="cosmos-gpu-bn-target">→ {tgtShort}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Stress Test HUD — decay curve + live metrics + controls. Runs only
          when Stress Test is on; sits right-aligned below the toolbar so the
          sidebar (left) and this panel (right) flank the graph without
          overlapping the selected-node popup (which also docks right but
          appears above this via z-index & only on selection). */}
      {stressTest && (() => {
        const chart = (() => {
          const W = 240, H = 60;
          const points = breakHistory;
          if (points.length === 0) return null;
          // X-axis max: during auto-play, scale to the user's chosen count so
          // the curve physically fills left-to-right as the run progresses.
          // Outside auto-play, just fit the current point set (min 10).
          const lastBroken = points[points.length - 1].broken;
          const maxBroken = autoSteps > 0
            ? Math.max(autoStepsCount, lastBroken, 1)
            : Math.max(10, lastBroken);
          const mapped = points.map((p) => ({
            x: (p.broken / maxBroken) * W,
            y: (1 - p.largestFrac) * H,
            broken: p.broken,
            largestFrac: p.largestFrac,
          }));
          const curve = mapped
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
            .join(' ');
          // Damage area: fill the region ABOVE the curve (from y=0 down to
          // the curve). Reads as "red damage grows from the top as breaks
          // accumulate" — opposite of the original bottom-up fill, which
          // painted the whole rect red while the graph was still mostly
          // intact (curve hugs y=0 when largestFrac ~= 1).
          const area =
            `M 0 0 ` +
            mapped.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') +
            ` L ${mapped[mapped.length - 1].x.toFixed(1)} 0 Z`;
          const last = mapped[mapped.length - 1];
          return { W, H, curve, area, last, maxBroken };
        })();
        const pct = Math.round(componentStats.largestFrac * 100);
        return (
          <div
            ref={stressHudRef}
            className="absolute right-3 z-30 px-3 py-2.5"
            style={{
              ...pillStyle,
              top: toolbarHeight + 18,
              width: 272,
              fontFamily: sysFont,
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <div
                className="text-[10px] uppercase tracking-wider"
                style={{ opacity: 0.6, letterSpacing: '0.08em' }}
              >
                What if — remove critical links
              </div>
              {autoSteps > 0 && (
                <span
                  className="text-[9px] font-bold"
                  style={{ color: '#ef4444', opacity: 0.85 }}
                >
                  AUTO ×{autoSteps}
                </span>
              )}
            </div>

            {/* Decay curve — y: % of graph in largest component, x: # edges removed */}
            {chart && (
              <div style={{ position: 'relative', marginBottom: 10 }}>
                <svg width={chart.W} height={chart.H + 12} style={{ overflow: 'visible', display: 'block' }}>
                  {/* Gridline at 50% to eyeball the halfway mark */}
                  <line
                    x1={0} y1={chart.H / 2} x2={chart.W} y2={chart.H / 2}
                    stroke="currentColor" strokeWidth={0.5} strokeDasharray="2 3" opacity={0.15}
                  />
                  <path d={chart.area} fill="rgba(239,68,68,0.12)" />
                  <path d={chart.curve} fill="none" stroke="#ef4444" strokeWidth={1.5} strokeLinejoin="round" />
                  <circle
                    cx={chart.last.x} cy={chart.last.y} r={3}
                    fill="#ef4444" stroke={isDark ? '#141518' : '#f5f5f7'} strokeWidth={1.5}
                  />
                  <text
                    x={chart.W} y={chart.H + 10}
                    textAnchor="end" fontSize={9} fill="currentColor" opacity={0.45}
                    fontFamily='"SF Mono", ui-monospace, monospace'
                  >
                    {chart.maxBroken} breaks
                  </text>
                  <text
                    x={0} y={chart.H + 10}
                    textAnchor="start" fontSize={9} fill="currentColor" opacity={0.45}
                    fontFamily='"SF Mono", ui-monospace, monospace'
                  >
                    0
                  </text>
                </svg>
              </div>
            )}

            {/* Live metrics — large headline + compact secondary stats */}
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[11px]" style={{ opacity: 0.7 }}>Graph intact</span>
              <span
                className="font-semibold"
                style={{
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  fontSize: 22,
                  letterSpacing: '-0.02em',
                  color: pct > 80 ? '#22c55e' : pct > 50 ? '#f59e0b' : '#ef4444',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {pct}%
              </span>
            </div>
            <div className="text-[11px] mb-3" style={{ opacity: 0.7 }}>
              <div className="flex justify-between">
                <span>Fragmented into</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {componentStats.count} {componentStats.count === 1 ? 'piece' : 'pieces'}
                </span>
              </div>
              <div className="flex justify-between" style={{ opacity: 0.75 }}>
                <span>Orphaned files</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{componentStats.isolated}</span>
              </div>
              <div className="flex justify-between" style={{ opacity: 0.75 }}>
                <span>Edges removed</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{brokenEdgeKeys.size}</span>
              </div>
            </div>

            {/* Controls — Break / Auto / Stop / Reset. Disable everything
                that would race the flash animation mid-break. */}
            <div className="flex flex-wrap gap-1.5">
              {autoSteps > 0 ? (
                <button
                  onClick={() => setAutoSteps(0)}
                  className="cosmos-gpu-pill-btn active"
                  title="Stop auto-destruction"
                  style={{ color: '#ef4444' }}
                >
                  ⏸ Stop
                </button>
              ) : (
                <>
                  <button
                    onClick={breakNextEdge}
                    className="cosmos-gpu-pill-btn active"
                    title="Remove the highest-scoring remaining edge"
                    disabled={pendingBreak != null}
                  >
                    Break next
                  </button>
                  <button
                    onClick={() => setAutoSteps(autoStepsCount)}
                    className="cosmos-gpu-pill-btn"
                    title={`Auto: remove the top ${autoStepsCount} hottest edges one by one with animation`}
                    disabled={pendingBreak != null}
                  >
                    ▶ Auto
                  </button>
                  <select
                    value={autoStepsCount}
                    onChange={(e) => setAutoStepsCount(parseInt(e.target.value, 10))}
                    className={inputBase}
                    style={{ ...inputStyle, border: 'none', padding: '2px 6px', fontSize: 11 }}
                    title="How many edges Auto should break in this run"
                    disabled={pendingBreak != null}
                  >
                    {[5, 10, 20, 30, 40, 50, 100].map((n) => (
                      <option key={n} value={n}>×{n}</option>
                    ))}
                  </select>
                </>
              )}
              <button
                onClick={resetStressTest}
                className="cosmos-gpu-pill-btn"
                title="Restore all broken edges and clear history"
                disabled={brokenEdgeKeys.size === 0 && autoSteps === 0 && breakHistory.length <= 1}
              >
                Reset
              </button>
            </div>

            {/* Live caption — during a single Break the current pendingBreak
                drives it; during Auto we fall back to lastPendingBreak so the
                caption stays visible through the ~100ms gap between breaks
                instead of blinking on/off every cycle. Opacity dips slightly
                during the gap so the user can still tell a flash is active. */}
            {(() => {
              const captionEdge = pendingBreak ?? (autoSteps > 0 ? lastPendingBreak : null);
              if (!captionEdge) return null;
              const live = pendingBreak != null;
              return (
                <div
                  className="mt-2 text-[10px]"
                  style={{
                    opacity: live ? 0.9 : 0.65,
                    color: '#fca5a5',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    transition: 'opacity 150ms',
                  }}
                  title={`${captionEdge.source} → ${captionEdge.target}`}
                >
                  ⚡ {captionEdge.source.split('/').pop()} → {captionEdge.target.split('/').pop()}
                </div>
              );
            })()}
          </div>
        );
      })()}

      {/* Halo overlay — additive radial-gradient glows around top-importance
          nodes. `plus-lighter` is GPU-accelerated in Chromium (unlike
          `screen`, which previously forced software compositing and cost
          us ~12 FPS on full-window views). */}
      <canvas
        ref={haloCanvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ mixBlendMode: 'plus-lighter' }}
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
        .cosmos-gpu-bn-row {
          display: block;
          width: 100%;
          text-align: left;
          padding: 5px 7px;
          margin-bottom: 2px;
          border-radius: 6px;
          border: 0.5px solid transparent;
          background: transparent;
          cursor: pointer;
          color: inherit;
          transition: background-color 120ms, border-color 120ms;
        }
        .cosmos-gpu-bn-row:hover {
          background: ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'};
          border-color: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'};
        }
        .cosmos-gpu-bn-row-top {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .cosmos-gpu-bn-dot {
          width: 7px; height: 7px; border-radius: 999px;
          flex-shrink: 0;
          box-shadow: 0 0 6px currentColor;
        }
        .cosmos-gpu-bn-name {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: "SF Mono", ui-monospace, Menlo, Monaco, monospace;
          font-size: 10.5px;
          letter-spacing: -0.01em;
        }
        .cosmos-gpu-bn-bridge {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.04em;
          color: #ef4444;
          padding: 0 4px;
          border: 0.5px solid rgba(239,68,68,0.5);
          border-radius: 3px;
        }
        .cosmos-gpu-bn-score {
          font-size: 10px;
          opacity: 0.65;
          font-variant-numeric: tabular-nums;
          font-family: "SF Mono", ui-monospace, Menlo, Monaco, monospace;
        }
        .cosmos-gpu-bn-target {
          margin-left: 13px;
          margin-top: 1px;
          font-family: "SF Mono", ui-monospace, Menlo, Monaco, monospace;
          font-size: 9.5px;
          opacity: 0.5;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cosmos-gpu-fps,
        .cosmos-gpu-stats {
          position: absolute;
          right: 12px;
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
        .cosmos-gpu-fps   { bottom: 43px; }
        .cosmos-gpu-stats { bottom: 10px; }
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

        {/* Bottleneck analysis — color edges by betweenness+co-change, highlight bridges & articulation points */}
        <button
          onClick={() => onSettingsChange({ bottlenecks: !bottlenecks, stressTest: stressTest && !bottlenecks ? false : stressTest })}
          className={`cosmos-gpu-pill-btn ${bottlenecks ? 'active' : ''}`}
          title="Highlight architectural bottlenecks: edge betweenness × co-change, with bridges & articulation points"
        >
          Bottlenecks
        </button>
        <button
          onClick={() => onSettingsChange({ stressTest: !stressTest, bottlenecks: !stressTest ? true : bottlenecks })}
          className={`cosmos-gpu-pill-btn ${stressTest ? 'active' : ''}`}
          title="Stress Test: interactively remove top-bottleneck edges and watch the graph fragment"
        >
          Stress Test
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

      {/* Stats — bottom-right, glass pill matching the FPS badge. */}
      {stats && (
        <div className="cosmos-gpu-stats">
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
        // Precompute the AI prompt once per render so the container width,
        // the inline preview, and the Copy button all read the same value.
        const bottleneckActive = bottlenecks || stressTest;
        const prompt = bottleneckActive ? buildBottleneckPrompt(selected, selectedEdge) : '';
        // Both the popup and the Stress Test HUD dock top-right; stack the
        // popup below the HUD when both are visible instead of overlapping.
        // Measured via ResizeObserver so the popup slots right under the HUD
        // regardless of its current height (chart + metrics + controls vary).
        const topOffset = stressTest && stressHudHeight > 0
          ? toolbarHeight + stressHudHeight + 30
          : toolbarHeight + 18;
        return (
          <div
            className="absolute right-3 z-20 px-3 py-2 text-[11px]"
            style={{
              ...pillStyle,
              borderRadius: 12,
              top: topOffset,
              // Wider when an AI prompt is shown below — the monospace block
              // needs room to breathe or the prompt wraps into an unreadable
              // column. Normal selection stays compact.
              width: prompt ? 420 : undefined,
              maxWidth: prompt ? 'calc(100% - 24px)' : 384,
              maxHeight: `calc(100% - ${topOffset + 18}px)`,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono break-all font-semibold">{selected.label}</div>
                {relPath && (() => {
                  // Truncate from the LEFT so the filename at the tail stays
                  // visible. CSS `direction: rtl` + `text-overflow: ellipsis`
                  // did not clip the start reliably for pure-LTR ASCII paths
                  // in this Electron build, so we slice in JS.
                  const full = absPath || relPath;
                  const maxChars = 52;
                  const shown = full.length > maxChars
                    ? '…' + full.slice(-(maxChars - 1))
                    : full;
                  return (
                    <div
                      className="mt-1 font-mono text-[10px]"
                      style={{
                        opacity: 0.75,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                      }}
                      title={full}
                    >
                      {shown}
                    </div>
                  );
                })()}
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

                {/* Inline AI prompt — shown in bottleneck mode when the node
                    carries a bottleneck signal. The user asked for the full
                    prompt to be visible, not just a copy button, so they can
                    sanity-check or tweak the text before pasting. Scrollable
                    so long prompts don't blow out the popup height. */}
                {prompt && (
                  <div className="mt-3" style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className="text-[10px] uppercase tracking-wider"
                        style={{ opacity: 0.55, letterSpacing: '0.08em' }}
                      >
                        {selectedEdge ? 'AI prompt · this edge' : 'AI prompt · this file'}
                      </span>
                      <button
                        className="cosmos-gpu-pill-btn"
                        title="Copy the prompt below to your clipboard"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(prompt);
                            setPromptCopied(true);
                            setTimeout(() => setPromptCopied(false), 1500);
                          } catch { /* clipboard blocked — ignore */ }
                        }}
                        style={{
                          padding: '2px 8px',
                          fontSize: 10,
                          color: promptCopied ? '#22c55e' : '#fca5a5',
                          borderColor: promptCopied ? 'rgba(34,197,94,0.4)' : 'rgba(252,165,165,0.35)',
                          borderWidth: '0.5px',
                          borderStyle: 'solid',
                        }}
                      >
                        {promptCopied ? '✓ Copied' : '✨ Copy'}
                      </button>
                    </div>
                    <div
                      className="text-[10px] mb-1.5"
                      style={{ opacity: 0.55, lineHeight: 1.4 }}
                    >
                      Copy this and paste into Claude / ChatGPT to investigate
                      the bottleneck and get refactoring suggestions.
                    </div>
                    <pre
                      onClick={(e) => {
                        // Single-click selects the whole prompt so ⌘C works
                        // even if the user doesn't want to hit the button.
                        const range = document.createRange();
                        range.selectNodeContents(e.currentTarget);
                        const sel = window.getSelection();
                        sel?.removeAllRanges();
                        sel?.addRange(range);
                      }}
                      style={{
                        maxHeight: 240,
                        overflowY: 'auto',
                        padding: '8px 10px',
                        borderRadius: 6,
                        background: isDark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.05)',
                        border: `0.5px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
                        fontSize: 10.5,
                        fontFamily: '"SF Mono", ui-monospace, Menlo, Monaco, monospace',
                        lineHeight: 1.45,
                        color: isDark ? '#d4d4d8' : '#27272a',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        cursor: 'text',
                        margin: 0,
                      }}
                    >
                      {prompt}
                    </pre>
                  </div>
                )}
              </div>
              <button
                onClick={() => { setSelected(null); setSelectedEdge(null); }}
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
