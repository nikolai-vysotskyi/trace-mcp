/**
 * Activity tab — live feed of MCP tool-calls for a project.
 *
 * Data sources:
 *  - Initial history: GET /api/projects/journal?project=<root>&limit=200
 *  - Live updates:    SSE /api/events  (filters events where event.project === root)
 *  - Aggregated stats: GET /api/projects/journal/stats?project=<root>&window=3600000
 *                      Fetched once on mount, then every 30 s.
 *
 * Behaviour:
 *  - Newest entries on top.
 *  - Auto-scrolls to top on new entry unless user has scrolled down.
 *  - Caps in-memory list to 1000 entries (drops oldest).
 *  - Filter chips: All / Errors only / top-5 tools by frequency.
 *  - Stats panel above feed: hot tools, latency histogram, error groups, sparkline.
 *    - Clicking a hot tool name filters the feed to that tool.
 *    - Clicking an error group filters to that tool with errors-only.
 *    - Live SSE events increment local counters between 30-s reconciliations.
 */

import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Icon } from '../lattice/icons';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  SearchField,
  SegmentedControl,
  StatusDot,
  Toolbar,
  ToolbarDivider,
  useMenuAnchor,
} from '../lattice/ui';

const BASE = 'http://127.0.0.1:3741';
const MAX_ENTRIES = 1000;
const STATS_INTERVAL_MS = 30_000;

// Window picker options for stats. Default is 1 hour; user can switch and the
// choice is persisted in localStorage under WINDOW_STORAGE_KEY.
const WINDOW_OPTIONS: { label: string; value: number }[] = [
  { label: '5m', value: 300_000 },
  { label: '1h', value: 3_600_000 },
  { label: '6h', value: 21_600_000 },
  { label: '24h', value: 86_400_000 },
];
const DEFAULT_WINDOW_MS = 3_600_000; // 1 hour
const VALID_WINDOWS = new Set(WINDOW_OPTIONS.map((o) => o.value));
const WINDOW_STORAGE_KEY = 'toolactivity.window';

function loadWindowMs(): number {
  if (typeof window === 'undefined') return DEFAULT_WINDOW_MS;
  try {
    const raw = window.localStorage.getItem(WINDOW_STORAGE_KEY);
    if (raw === null) return DEFAULT_WINDOW_MS;
    const parsed = Number(raw);
    return VALID_WINDOWS.has(parsed) ? parsed : DEFAULT_WINDOW_MS;
  } catch {
    return DEFAULT_WINDOW_MS;
  }
}

function windowLabel(ms: number): string {
  return WINDOW_OPTIONS.find((o) => o.value === ms)?.label ?? '1h';
}

// ── Types ─────────────────────────────────────────────────────────────────

interface JournalEntry {
  type: 'journal_entry';
  project: string;
  ts: number;
  tool: string;
  params_summary: string;
  result_count: number;
  result_tokens?: number;
  latency_ms?: number;
  is_error: boolean;
  session_id: string;
}

// Matches JournalStatsResponse from journal-stats-routes.ts
interface HotTool {
  tool: string;
  count: number;
  avg_latency_ms: number;
  error_count: number;
}

interface HotFile {
  file: string;
  count: number;
}

interface LatencyBucket {
  bucket_ms: number; // -1 = open-ended >=5000ms
  count: number;
}

interface ErrorGroup {
  tool: string;
  sample_summary: string;
  count: number;
}

interface ByMinute {
  ts: number;
  count: number;
  error_count: number;
}

interface JournalStats {
  window_ms: number;
  total_calls: number;
  error_rate: number;
  hot_tools: HotTool[];
  hot_files: HotFile[];
  latency_buckets: LatencyBucket[];
  error_groups: ErrorGroup[];
  by_minute: ByMinute[];
  // Present when the stats endpoint was queried with a `before` param so the
  // caller can confirm which window the response covers. Optional — the
  // "window ends at now" path omits it.
  window_end?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 5000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Stable React/selection key for a journal entry. Mirrors the inline key used
 * in both render paths so the lifted `expandedKeys` set lines up with the keys
 * passed to <EntryRow>.
 */
function entryKey(e: JournalEntry): string {
  return `${e.ts}:${e.tool}:${e.session_id}:${e.params_summary.slice(0, 32)}`;
}

/**
 * Splits `text` around a case-insensitive substring `q` and returns React-ready
 * fragments where matches are wrapped in <mark>. Returns the plain string when
 * q is empty or has no match. Operates on the already-truncated string, so the
 * highlight always lines up with what the user sees.
 */
function highlightMatch(text: string, q: string): ReactNode {
  if (q === '') return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx === -1) return text;
  const markStyle: CSSProperties = {
    background: 'color-mix(in oklab, var(--accent) 22%, transparent)',
    color: 'inherit',
    padding: 0,
    borderRadius: 2,
  };
  const parts: ReactNode[] = [];
  let cursor = 0;
  let nextIdx = idx;
  let key = 0;
  while (nextIdx !== -1) {
    if (nextIdx > cursor) parts.push(text.slice(cursor, nextIdx));
    parts.push(
      <mark key={key++} style={markStyle}>
        {text.slice(nextIdx, nextIdx + needle.length)}
      </mark>,
    );
    cursor = nextIdx + needle.length;
    nextIdx = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

// Mirror of FILE_EXTS_RE from src/api/journal-stats-routes.ts (~line 131).
// Kept inline rather than shared because this file ships to the Electron
// renderer, which can't import from the node-side backend module graph.
// If the server regex changes, update this one too.
const FILE_PATH_RE =
  /\b([\w.\-/@]+\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|rb|php|cs|cpp|c|h|hpp|swift|vue|svelte|astro))\b/g;

/**
 * Tokenizes `text` into a flat array of nodes:
 *   - File-path matches → <button> (clickable, copies to clipboard)
 *   - Search-query matches → <mark> (existing search highlight)
 *   - Plain text segments → string
 *
 * File-path matches WIN over search-query overlap — the button takes precedence
 * and the <mark> is not applied inside it. Search-query <mark> is only emitted
 * in the gaps between file-path spans.
 */
function tokenizeParams(
  text: string,
  q: string,
  onFileClick: (file: string, e: MouseEvent) => void,
  navigates: boolean,
): ReactNode {
  // 1. Collect all file-path spans (non-overlapping by regex semantics).
  const fileSpans: { start: number; end: number; file: string }[] = [];
  FILE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_PATH_RE.exec(text)) !== null) { // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- FILE_PATH_RE is a single bounded character class + literal extension list, no nested/overlapping quantifiers, so no catastrophic backtracking.
    fileSpans.push({ start: m.index, end: m.index + m[1].length, file: m[1] });
  }

  if (fileSpans.length === 0) {
    // No file paths — fall back to plain search highlight.
    return highlightMatch(text, q);
  }

  // 2. Walk the text, emitting file-buttons for file-path spans and
  //    search-highlight for the gaps between them.
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  const btnStyle: CSSProperties = {
    background: 'none',
    border: 'none',
    padding: 0,
    margin: 0,
    color: 'var(--accent)',
    cursor: 'pointer',
    font: 'inherit',
    textDecoration: 'none',
  };
  for (const span of fileSpans) {
    if (span.start > cursor) {
      // Gap before this file-path: apply search highlight here.
      const gap = text.slice(cursor, span.start);
      parts.push(<span key={key++}>{highlightMatch(gap, q)}</span>);
    }
    parts.push(
      <button
        key={key++}
        type="button"
        // Primary action: open the file's node in the Graph tab (when a
        // navigation handler is wired). ⌥/⌘-click copies the path instead.
        // Without a handler this falls back to copy-only (see EntryRow).
        onClick={(e) => {
          e.stopPropagation();
          // Pass the FULL matched path token (span.file), not the truncated
          // display text, so navigation/copy operate on the real path.
          onFileClick(span.file, e);
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.textDecoration = 'underline';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.textDecoration = 'none';
        }}
        title={
          navigates
            ? 'Click to open in Graph · ⌥-click to copy path'
            : 'Click to copy path'
        }
        style={btnStyle}
      >
        {span.file}
      </button>,
    );
    cursor = span.end;
  }
  if (cursor < text.length) {
    const tail = text.slice(cursor);
    parts.push(<span key={key++}>{highlightMatch(tail, q)}</span>);
  }
  return parts;
}

function topTools(entries: JournalEntry[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([tool]) => tool);
}

function formatLatencyBucket(bucket_ms: number): string {
  if (bucket_ms === -1) return '5s+';
  if (bucket_ms === 0) return '<10ms';
  if (bucket_ms < 1000) return `${bucket_ms}ms`;
  return `${bucket_ms / 1000}s`;
}

// p95 from latency_buckets (approximate — uses bucket left-edges)
function computeP95(buckets: LatencyBucket[]): string {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) return '—';
  const threshold = total * 0.95;
  let cumulative = 0;
  for (const b of buckets) {
    cumulative += b.count;
    if (cumulative >= threshold) {
      return formatLatencyBucket(b.bucket_ms);
    }
  }
  return formatLatencyBucket(buckets[buckets.length - 1]?.bucket_ms ?? -1);
}

// Numeric p95 (bucket left-edge, in ms) for delta arithmetic. Mirrors the
// bucket-selection logic of computeP95 but returns the raw left-edge value
// instead of a formatted string. The open-ended ">=5000ms" bucket (-1) is
// treated as 5000ms so deltas stay finite. Returns 0 when there is no data.
function p95Ms(buckets: LatencyBucket[]): number {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) return 0;
  const threshold = total * 0.95;
  let cumulative = 0;
  for (const b of buckets) {
    cumulative += b.count;
    if (cumulative >= threshold) {
      return b.bucket_ms === -1 ? 5000 : b.bucket_ms;
    }
  }
  const last = buckets[buckets.length - 1]?.bucket_ms ?? -1;
  return last === -1 ? 5000 : last;
}

// ── Baseline (vs-previous-window) delta rendering ──────────────────────────

interface DeltaInfo {
  // Display string for the badge: e.g. "+42%", "−18%", "↑2.4×", "new", "—".
  text: string;
  // 'up' / 'down' / 'flat' describes the raw numeric direction (cur vs prev),
  // independent of whether that direction is good or bad.
  direction: 'up' | 'down' | 'flat';
  // Whether prev was 0 and cur > 0 (the "new" case — no ratio computable).
  isNew: boolean;
}

/**
 * Computes a compact delta descriptor comparing `cur` to `prev`.
 *  - prev === 0 && cur > 0  → "new"
 *  - prev === 0 && cur === 0 → "—"
 *  - |ratio| >= 2×          → multiplier form "↑2.4×" / "↓3×"
 *  - otherwise              → percentage form "+42%" / "−18%"
 * The minus sign uses U+2212 (−) to match the spec's display.
 */
function computeDelta(cur: number, prev: number): DeltaInfo {
  if (prev === 0) {
    if (cur > 0) return { text: 'new', direction: 'up', isNew: true };
    return { text: '—', direction: 'flat', isNew: false };
  }
  if (cur === prev) return { text: '0%', direction: 'flat', isNew: false };
  const direction: 'up' | 'down' = cur > prev ? 'up' : 'down';
  const ratio = cur / prev;
  // Multiplier form for large swings (>=2x in either direction).
  if (ratio >= 2 || ratio <= 0.5) {
    const mult = direction === 'up' ? ratio : prev / cur;
    const rounded = mult >= 10 ? Math.round(mult) : Math.round(mult * 10) / 10;
    const arrow = direction === 'up' ? '↑' : '↓';
    return { text: `${arrow}${rounded}×`, direction, isNew: false };
  }
  const pct = ((cur - prev) / prev) * 100;
  const rounded = Math.round(pct);
  const sign = rounded > 0 ? '+' : '−';
  return { text: `${sign}${Math.abs(rounded)}%`, direction, isNew: false };
}

/**
 * Renders the compact "vs previous window" badge for one metric.
 *  - `higherIsBad`: when true, an upward direction is red and downward green
 *    (error rate, latency). When false, the change is neutral (calls volume).
 * Renders nothing meaningful when prev is unavailable — callers should guard.
 */
function DeltaBadge({
  cur,
  prev,
  higherIsBad,
  windowMs,
  curLabel,
  prevLabel,
  unit,
}: {
  cur: number;
  prev: number;
  higherIsBad: boolean;
  windowMs: number;
  curLabel: string;
  prevLabel: string;
  unit: string;
}) {
  const delta = computeDelta(cur, prev);
  let color = 'var(--label-secondary)';
  if (higherIsBad && delta.direction !== 'flat') {
    color = delta.direction === 'up' ? 'var(--status-red)' : 'var(--status-green)';
  }
  /* The arrow is not decoration: it is the second channel that carries
     "better / worse" for anyone who cannot separate the red from the green. */
  const glyph = delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '';
  const title = `vs previous ${windowLabel(windowMs)}: ${prevLabel} → ${curLabel}${unit ? ` ${unit}` : ''}`;
  /* "184 calls 0%" reads as a broken number. No change is not a delta — the
     comparison lives in the tooltip and the badge stays out of the way. */
  if (delta.direction === 'flat') return null;
  return (
    <span
      className="tabular-nums text-[11px] leading-[13px]"
      style={{ color, marginLeft: 3, whiteSpace: 'nowrap' }}
      title={title}
    >
      {glyph}
      {delta.text}
    </span>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

/** The tool identifier, as a monospace badge. Identifiers are not prose, so
    this is the one place sentence case does not apply — `get_outline` is its
    own name. Tone carries the same signal the row's Error badge spells out. */
function ToolBadge({ tool, isError }: { tool: string; isError: boolean }) {
  return (
    <span
      className={`lx-badge ${isError ? 't-red' : 't-accent'} shrink-0`}
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {tool}
    </span>
  );
}

function EntryRow({
  entry,
  query = '',
  indent = 0,
  isSelected = false,
  expanded = false,
  onToggleExpand,
  entryIdx,
  onOpenFileInGraph,
}: {
  entry: JournalEntry;
  query?: string;
  indent?: number;
  isSelected?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  entryIdx?: number;
  onOpenFileInGraph?: (filePath: string) => void;
}) {
  const [, setTick] = useState(0);
  // Set when the user clicks a file-path in params_summary; cleared after 1.5s.
  // Lives per-row so multiple rows can show "Copied" independently.
  const [recentlyCopied, setRecentlyCopied] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Re-render every 10s so relative timestamps update
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  // Clean up the "Copied" fade timer if the row unmounts mid-flight.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const rowBg = entry.is_error
    ? 'color-mix(in oklab, var(--status-red) 7%, transparent)'
    : 'transparent';
  const absoluteTime = new Date(entry.ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const handleCopyParams = (e: MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(entry.params_summary);
  };

  // Clicking a file-path token in params_summary navigates the project window
  // to the Graph tab and focuses that file's node (primary action). A modifier
  // click (⌥ or ⌘) copies the path to the clipboard and shows a transient
  // "Copied" note instead. When no navigation handler is wired (defensive
  // fallback), every click copies the path.
  const copyFilePath = useCallback((file: string) => {
    void navigator.clipboard.writeText(file);
    setRecentlyCopied(file);
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      setRecentlyCopied(null);
      copiedTimerRef.current = null;
    }, 1500);
  }, []);
  const handleFilePathClick = useCallback(
    (file: string, e: MouseEvent) => {
      const wantsCopy = e.altKey || e.metaKey;
      if (onOpenFileInGraph && !wantsCopy) {
        onOpenFileInGraph(file);
        return;
      }
      copyFilePath(file);
    },
    [onOpenFileInGraph, copyFilePath],
  );

  return (
    <div
      data-entry-idx={entryIdx}
      style={{
        borderBottom: '0.5px solid var(--separator)',
        background: isSelected ? 'var(--fill-tertiary)' : rowBg,
        paddingLeft: indent,
        borderLeft: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
      }}
    >
      {/* Collapsed row — clickable. Must NOT be a <button>: the params summary
          renders clickable file-path <button>s, and a <button> nested inside a
          <button> is invalid HTML. Chromium reparents the inner button out of
          the row, desyncing React's DOM refs and crashing react-dom on the next
          re-render. Use a div with role="button" so the inner buttons are valid. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onToggleExpand?.()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand?.();
          }
        }}
        className="flex items-start gap-2 px-3 py-2 w-full text-left"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          minHeight: 36,
          transition: 'background var(--dur-micro) var(--ease-out)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--fill-quaternary)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'none';
        }}
      >
        {/* Relative time */}
        <span
          className="shrink-0 text-[11px] leading-[13px] tabular-nums mt-1 w-14 text-right"
          style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-mono)' }}
        >
          {relativeTime(entry.ts)}
        </span>

        {/* Tool badge */}
        <span className="shrink-0 mt-0.5">
          <ToolBadge tool={entry.tool} isError={entry.is_error} />
        </span>

        {/* Error is stated, not tinted. Red text and a red row wash are the
            same channel twice; the badge is what a monochrome reader sees. */}
        {entry.is_error && (
          <span className="shrink-0 mt-0.5">
            <Badge tone="red" icon="warning">
              Error
            </Badge>
          </span>
        )}

        {/* Params summary */}
        <div className="flex-1 min-w-0">
          <div
            className="text-[13px] leading-4 truncate"
            style={{
              color: 'var(--label)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {tokenizeParams(
              truncate(entry.params_summary, 120),
              query,
              handleFilePathClick,
              onOpenFileInGraph !== undefined,
            )}
            {recentlyCopied !== null && (
              <span
                className="ml-2 text-[11px] leading-[13px]"
                style={{
                  color: 'var(--status-green)',
                  fontFamily: 'var(--font-ui)',
                }}
                title={recentlyCopied}
              >
                Copied
              </span>
            )}
          </div>
          <div
            className="flex items-center gap-2 mt-0.5 text-[11px] leading-[13px] tabular-nums"
            style={{ color: 'var(--label-secondary)' }}
          >
            <span>
              {entry.result_count} result{entry.result_count === 1 ? '' : 's'}
            </span>
            {entry.latency_ms !== undefined && (
              <span>
                {entry.latency_ms < 1000
                  ? `${entry.latency_ms} ms`
                  : `${(entry.latency_ms / 1000).toFixed(1)} s`}
              </span>
            )}
            {entry.result_tokens !== undefined && (
              <span>~{entry.result_tokens.toLocaleString()} tokens</span>
            )}
          </div>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            padding: '4px 12px 10px 76px',
            fontSize: 12,
            lineHeight: '15px',
            fontFamily: 'var(--font-mono)',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '3px 12px',
            color: 'var(--label)',
          }}
        >
          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>Time</span>
          <span>{absoluteTime}</span>

          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>
            Session
          </span>
          <span style={{ wordBreak: 'break-all' }}>{entry.session_id}</span>

          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>Tool</span>
          <span style={{ wordBreak: 'break-all' }}>{entry.tool}</span>

          <span
            style={{
              color: 'var(--label-secondary)',
              fontFamily: 'var(--font-ui)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            Params
            <Button size="small" onClick={handleCopyParams} title="Copy full params to clipboard">
              Copy
            </Button>
          </span>
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {entry.params_summary}
          </span>

          <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>
            Results
          </span>
          <span>{entry.result_count}</span>

          {entry.latency_ms !== undefined && (
            <>
              <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>
                Latency
              </span>
              <span>{entry.latency_ms} ms</span>
            </>
          )}

          {entry.result_tokens !== undefined && (
            <>
              <span style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-ui)' }}>
                Tokens
              </span>
              <span>{entry.result_tokens.toLocaleString()}</span>
            </>
          )}

          {entry.is_error && (
            <>
              <span style={{ color: 'var(--status-red)', fontFamily: 'var(--font-ui)' }}>Error</span>
              <span style={{ color: 'var(--status-red)', fontFamily: 'var(--font-ui)' }}>
                This call returned an error.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Stats sub-components ──────────────────────────────────────────────────

/**
 * Top-row summary bar: total calls, error rate, p95 latency.
 * Always visible; clicking the chevron expands/collapses the full panel.
 */
function StatsSummaryBar({
  stats,
  prevStats,
  expanded,
  onToggle,
  windowMs,
  onWindowChange,
}: {
  stats: JournalStats;
  prevStats: JournalStats | null;
  expanded: boolean;
  onToggle: () => void;
  windowMs: number;
  onWindowChange: (ms: number) => void;
}) {
  const errorPct = (stats.error_rate * 100).toFixed(1);
  const p95 = computeP95(stats.latency_buckets);
  const curP95Ms = p95Ms(stats.latency_buckets);
  const errorColor =
    stats.error_rate > 0.1
      ? 'var(--status-red)'
      : stats.error_rate > 0.02
        ? 'var(--status-orange)'
        : 'var(--label)';

  // Stops the picker click/key event from bubbling to the bar's expand/collapse handler.
  const stopBubble = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
  };

  return (
    <div
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label="Statistics"
      className="w-full flex items-center gap-3 px-4 py-1.5 text-left"
      style={{
        background: 'var(--surface)',
        border: 'none',
        borderBottom: '0.5px solid var(--separator)',
        cursor: 'pointer',
      }}
    >
      <span
        className="text-[11px] leading-[13px] font-semibold"
        style={{ color: 'var(--label-secondary)' }}
      >
        Stats
      </span>
      {/* Window picker — segmented control, click does not toggle the bar */}
      <div onClick={stopBubble} onKeyDown={stopBubble} className="shrink-0">
        <SegmentedControl
          size="small"
          options={WINDOW_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
          value={String(windowMs)}
          onChange={(v) => onWindowChange(Number(v))}
          aria-label="Stats window"
        />
      </div>
      <span
        className="flex items-center gap-1 text-[13px] leading-4"
        style={{ color: 'var(--label)' }}
      >
        <span className="font-semibold tabular-nums">{stats.total_calls.toLocaleString()}</span>
        <span style={{ color: 'var(--label-secondary)' }}>calls</span>
        {prevStats !== null && (
          <DeltaBadge
            cur={stats.total_calls}
            prev={prevStats.total_calls}
            higherIsBad={false}
            windowMs={windowMs}
            curLabel={stats.total_calls.toLocaleString()}
            prevLabel={prevStats.total_calls.toLocaleString()}
            unit="calls"
          />
        )}
      </span>
      <span
        className="flex items-center gap-1 text-[13px] leading-4"
        style={{ color: errorColor }}
      >
        <span className="font-semibold tabular-nums">{errorPct}%</span>
        <span style={{ color: 'var(--label-secondary)' }}>errors</span>
        {prevStats !== null && (
          <DeltaBadge
            cur={stats.error_rate}
            prev={prevStats.error_rate}
            higherIsBad
            windowMs={windowMs}
            curLabel={`${(stats.error_rate * 100).toFixed(1)}%`}
            prevLabel={`${(prevStats.error_rate * 100).toFixed(1)}%`}
            unit=""
          />
        )}
      </span>
      <span
        className="flex items-center gap-1 text-[13px] leading-4"
        style={{ color: 'var(--label)' }}
      >
        <span className="font-semibold tabular-nums">{p95}</span>
        <span style={{ color: 'var(--label-secondary)' }}>p95</span>
        {prevStats !== null && (
          <DeltaBadge
            cur={curP95Ms}
            prev={p95Ms(prevStats.latency_buckets)}
            higherIsBad
            windowMs={windowMs}
            curLabel={p95}
            prevLabel={computeP95(prevStats.latency_buckets)}
            unit=""
          />
        )}
      </span>
      <span className="ml-auto flex" style={{ color: 'var(--label-secondary)' }}>
        <Icon name={expanded ? 'expand_less' : 'expand_more'} size={16} />
      </span>
    </div>
  );
}

/** Chart / group caption. 11px/600 sentence case — the house scale has no
    10.5px, and ALL-CAPS is reserved for 10px table headers. */
function ChartTitle({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-[11px] leading-[13px] font-semibold mb-1.5"
      style={{ color: 'var(--label-secondary)' }}
    >
      {children}
    </div>
  );
}

/**
 * Horizontal bar chart for hot tools (pure CSS, no chart lib).
 */
function HotToolsChart({
  tools,
  onToolClick,
  toolFilter,
}: {
  tools: HotTool[];
  onToolClick: (tool: string) => void;
  toolFilter: Set<string>;
}) {
  if (tools.length === 0) return null;
  const maxCount = tools[0].count;
  return (
    <div>
      <ChartTitle>Most-used tools</ChartTitle>
      <div className="flex flex-col gap-1">
        {tools.map((t) => {
          const pct = maxCount > 0 ? (t.count / maxCount) * 100 : 0;
          const isActive = toolFilter.has(t.tool);
          const hasErrors = t.error_count > 0;
          return (
            <button
              key={t.tool}
              type="button"
              onClick={() => onToolClick(t.tool)}
              className="flex items-center gap-2 w-full text-left"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 0' }}
              title={`avg ${t.avg_latency_ms}ms · ${t.error_count} errors`}
            >
              <span
                className="shrink-0 text-[11px] leading-[13px] tabular-nums w-36 truncate"
                style={{
                  color: isActive ? 'var(--accent)' : 'var(--label)',
                  fontWeight: isActive ? 600 : 400,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {t.tool}
              </span>
              <div
                className="flex-1 relative h-2 overflow-hidden"
                style={{ background: 'var(--fill-quaternary)', borderRadius: 2 }}
              >
                <div
                  className="absolute inset-y-0 left-0"
                  style={{
                    width: `${pct}%`,
                    borderRadius: 2,
                    background: 'var(--accent)',
                    opacity: isActive ? 1 : 0.75,
                    transition: 'width var(--dur-large) var(--ease-out)',
                  }}
                />
              </div>
              {/* The bar's tone says "this tool errors"; the count says how
                  many, so the signal survives without colour. */}
              {hasErrors && (
                <span
                  className="shrink-0 text-[11px] leading-[13px] tabular-nums"
                  style={{ color: 'var(--status-red)' }}
                  title={`${t.error_count} errors`}
                >
                  ⚠ {t.error_count}
                </span>
              )}
              <span
                className="shrink-0 text-[11px] leading-[13px] tabular-nums w-8 text-right"
                style={{ color: 'var(--label-secondary)' }}
              >
                {t.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Horizontal bar chart for hot files (pure CSS, mirrors HotToolsChart).
 * Renders nothing when the list is empty.
 */
function HotFilesList({ files }: { files: HotFile[] }) {
  if (files.length === 0) return null;
  const maxCount = files[0].count;
  return (
    <div>
      <ChartTitle>Most-read files</ChartTitle>
      <div className="flex flex-col gap-1">
        {files.map((f) => {
          const pct = maxCount > 0 ? (f.count / maxCount) * 100 : 0;
          const displayPath =
            f.file.length > 28 ? `…${f.file.slice(f.file.length - 28)}` : f.file;
          // TODO: clickable filter in future iteration
          return (
            <div
              key={f.file}
              className="flex items-center gap-2 w-full"
              style={{ padding: '1px 0' }}
              title={f.file}
            >
              <span
                className="shrink-0 text-[11px] leading-[13px] tabular-nums w-32 truncate"
                style={{ color: 'var(--label)', fontFamily: 'var(--font-mono)' }}
              >
                {displayPath}
              </span>
              <div
                className="flex-1 relative h-2 overflow-hidden"
                style={{ background: 'var(--fill-quaternary)', borderRadius: 2 }}
              >
                <div
                  className="absolute inset-y-0 left-0"
                  style={{
                    width: `${pct}%`,
                    borderRadius: 2,
                    background: 'var(--accent)',
                    opacity: 0.75,
                    transition: 'width var(--dur-large) var(--ease-out)',
                  }}
                />
              </div>
              <span
                className="shrink-0 text-[11px] leading-[13px] tabular-nums w-8 text-right"
                style={{ color: 'var(--label-secondary)' }}
              >
                {f.count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Vertical bar latency histogram (pure CSS).
 */
function LatencyHistogram({ buckets }: { buckets: LatencyBucket[] }) {
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <div>
      <ChartTitle>Latency</ChartTitle>
      {/* One label per bar was 8px and unreadable at any width the panel gets.
          A histogram's x-axis only has to name its ends; the rest is the
          shape, and each bar keeps its own bucket in the tooltip. */}
      <div className="flex items-end gap-0.5" style={{ height: 32 }}>
        {buckets.map((b) => {
          const heightPct = (b.count / maxCount) * 100;
          const label = formatLatencyBucket(b.bucket_ms);
          return (
            <div
              key={b.bucket_ms}
              className="flex-1 flex items-end h-full"
              title={`${label}: ${b.count} call${b.count === 1 ? '' : 's'}`}
            >
              <div
                className="w-full"
                style={{
                  height: `${heightPct}%`,
                  minHeight: b.count > 0 ? 2 : 0,
                  borderRadius: '2px 2px 0 0',
                  background: 'var(--accent)',
                  opacity: 0.75,
                  transition: 'height var(--dur-large) var(--ease-out)',
                }}
              />
            </div>
          );
        })}
      </div>
      <div
        className="flex items-center justify-between mt-1 pt-1 text-[11px] leading-[13px] tabular-nums"
        style={{ color: 'var(--label-secondary)', borderTop: '0.5px solid var(--separator)' }}
      >
        <span>{formatLatencyBucket(buckets[0]?.bucket_ms ?? 0)}</span>
        <span>{formatLatencyBucket(buckets[buckets.length - 1]?.bucket_ms ?? -1)}</span>
      </div>
    </div>
  );
}

/**
 * Error groups: collapsible list with count badge.
 * Clicking a group sets filter to that tool with errors-only.
 */
function ErrorGroupsList({
  groups,
  onGroupClick,
  toolFilter,
  errorsOnly,
}: {
  groups: ErrorGroup[];
  onGroupClick: (tool: string) => void;
  toolFilter: Set<string>;
  errorsOnly: boolean;
}) {
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  if (groups.length === 0) return null;

  return (
    <div>
      <ChartTitle>Errors by tool</ChartTitle>
      <div className="flex flex-col gap-0.5">
        {groups.map((g) => {
          const isExpanded = expandedTool === g.tool;
          const isActive = errorsOnly && toolFilter.has(g.tool);
          return (
            <div key={g.tool}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="lx-btn v-icon sz-small shrink-0"
                  onClick={() => setExpandedTool(isExpanded ? null : g.tool)}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? 'Hide' : 'Show'} a sample error for ${g.tool}`}
                  title={isExpanded ? 'Hide sample' : 'Show sample'}
                >
                  <Icon name={isExpanded ? 'expand_more' : 'chevron_right'} size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => onGroupClick(g.tool)}
                  className="flex-1 text-left text-[11px] leading-[13px] truncate"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: isActive ? 'var(--status-red)' : 'var(--label)',
                    fontWeight: isActive ? 600 : 400,
                    fontFamily: 'var(--font-mono)',
                    padding: 0,
                  }}
                  title={`Show only ${g.tool} errors`}
                >
                  {g.tool}
                </button>
                <Badge tone="red">{g.count}</Badge>
              </div>
              {isExpanded && (
                <div
                  className="mt-0.5 ml-5 text-[11px] leading-[13px] truncate px-1.5 py-1"
                  style={{
                    background: 'color-mix(in oklab, var(--status-red) 7%, transparent)',
                    borderRadius: 6,
                    color: 'var(--label-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                  title={g.sample_summary}
                >
                  {truncate(g.sample_summary, 100)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Sparkline: vertical bars for by_minute data covering the active window.
 * NOTE: for ≥6h windows, by_minute could be down-sampled server-side later.
 *
 * Interactive: dragging horizontally across the bars selects a time interval
 * which the parent uses to filter the FEED (client-side only — does NOT touch
 * the server stats window). Pointer events are tracked on the bar container:
 *  - pointerdown records the bar index under the cursor (drag anchor)
 *  - pointermove updates the hovered bar index while a drag is in progress
 *  - pointerup commits [start, end] from the min/max ts of covered bars
 *  - a click (anchor === release on the same bar) selects that single minute
 *  - double-click clears the selection
 * While dragging, a translucent accent overlay rectangle spans the covered bars.
 */
function Sparkline({
  byMinute,
  windowMs,
  onSelectRange,
  activeRange,
}: {
  byMinute: ByMinute[];
  windowMs: number;
  onSelectRange: (range: { start: number; end: number } | null) => void;
  activeRange: { start: number; end: number } | null;
}) {
  const maxCount = Math.max(...byMinute.map((m) => m.count), 1);
  const barsRef = useRef<HTMLDivElement>(null);
  // Drag anchor bar index (set on pointerdown) and the current hovered bar
  // index (updated on pointermove). null when no drag is in progress.
  const dragAnchorRef = useRef<number | null>(null);
  const [dragRange, setDragRange] = useState<{ lo: number; hi: number } | null>(null);

  // Map a clientX onto a bar index within the container. Returns null when the
  // container has no width or no bars yet.
  const barIndexAtX = useCallback(
    (clientX: number): number | null => {
      const el = barsRef.current;
      if (!el || byMinute.length === 0) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return null;
      const ratio = (clientX - rect.left) / rect.width;
      const idx = Math.floor(ratio * byMinute.length);
      return Math.max(0, Math.min(byMinute.length - 1, idx));
    },
    [byMinute.length],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const idx = barIndexAtX(e.clientX);
      if (idx === null) return;
      dragAnchorRef.current = idx;
      setDragRange({ lo: idx, hi: idx });
      // Capture so we keep getting move/up even if the pointer leaves the box.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [barIndexAtX],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const anchor = dragAnchorRef.current;
      if (anchor === null) return;
      const idx = barIndexAtX(e.clientX);
      if (idx === null) return;
      setDragRange({ lo: Math.min(anchor, idx), hi: Math.max(anchor, idx) });
    },
    [barIndexAtX],
  );

  const commitSelection = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const anchor = dragAnchorRef.current;
      dragAnchorRef.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      if (anchor === null) {
        setDragRange(null);
        return;
      }
      const release = barIndexAtX(e.clientX) ?? anchor;
      const lo = Math.min(anchor, release);
      const hi = Math.max(anchor, release);
      setDragRange(null);
      const first = byMinute[lo];
      const last = byMinute[hi];
      if (!first || !last) return;
      // Start at the first covered minute's ts; end at last covered minute + 60s
      // so the interval is inclusive of the whole last bucket.
      onSelectRange({ start: first.ts, end: last.ts + 60_000 });
    },
    [barIndexAtX, byMinute, onSelectRange],
  );

  // Determine which bars fall inside the committed activeRange so they render
  // highlighted even when no drag is in progress.
  const isActive = useCallback(
    (ts: number) =>
      activeRange !== null && ts >= activeRange.start && ts < activeRange.end,
    [activeRange],
  );

  return (
    <div>
      <div className="flex items-center gap-1 mb-1.5">
        <ChartTitle>Last {windowLabel(windowMs)}</ChartTitle>
        {activeRange !== null && (
          <button
            type="button"
            onClick={() => onSelectRange(null)}
            title="Clear time-range filter"
            aria-label="Clear time-range filter"
            className="lx-btn v-plain sz-small -mt-1.5"
          >
            Clear
          </button>
        )}
      </div>
      <div
        ref={barsRef}
        className="flex items-end gap-px relative"
        style={{ height: 28, cursor: 'crosshair', touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={commitSelection}
        onPointerCancel={commitSelection}
        onDoubleClick={() => onSelectRange(null)}
      >
        {byMinute.map((m) => {
          const heightPct = (m.count / maxCount) * 100;
          const hasErrors = m.error_count > 0;
          const inRange = isActive(m.ts);
          const minuteLabel = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return (
            <div
              key={m.ts}
              className="flex-1 rounded-t-sm"
              title={`${minuteLabel}: ${m.count} calls${hasErrors ? `, ${m.error_count} errors` : ''}`}
              style={{
                height: `${heightPct}%`,
                minHeight: m.count > 0 ? 2 : 0,
                background: hasErrors ? 'var(--status-red)' : 'var(--accent)',
                opacity: activeRange !== null ? (inRange ? 1 : 0.3) : 0.75,
                transition: 'height var(--dur-large) var(--ease-out), opacity var(--dur-micro) var(--ease-out)',
              }}
            />
          );
        })}
        {/* Live drag overlay — spans the covered bars at ~0.15 alpha. */}
        {dragRange !== null && byMinute.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${(dragRange.lo / byMinute.length) * 100}%`,
              width: `${((dragRange.hi - dragRange.lo + 1) / byMinute.length) * 100}%`,
              background: 'var(--accent)',
              opacity: 0.15,
              borderRadius: 2,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The full expandable Stats panel.
 */
function StatsPanel({
  stats,
  onToolClick,
  onErrorGroupClick,
  toolFilter,
  errorsOnly,
  windowMs,
  onSelectRange,
  timeRange,
}: {
  stats: JournalStats;
  onToolClick: (tool: string) => void;
  onErrorGroupClick: (tool: string) => void;
  toolFilter: Set<string>;
  errorsOnly: boolean;
  windowMs: number;
  onSelectRange: (range: { start: number; end: number } | null) => void;
  timeRange: { start: number; end: number } | null;
}) {
  return (
    <div
      className="shrink-0 px-4 py-3 flex flex-col gap-4"
      style={{
        borderBottom: '0.5px solid var(--separator)',
        background: 'var(--surface)',
      }}
    >
      {/* Row 1: hot tools + latency histogram side by side */}
      <div className="flex gap-4">
        <div className="flex-1 min-w-0">
          <HotToolsChart
            tools={stats.hot_tools}
            onToolClick={onToolClick}
            toolFilter={toolFilter}
          />
        </div>
        <div style={{ width: 140, flexShrink: 0 }}>
          <LatencyHistogram buckets={stats.latency_buckets} />
        </div>
      </div>

      {/*
       * Row 2: 3-column flex — HotFiles (flex-1) + ErrorGroups (flex-1) + Sparkline (140px).
       * Chosen over inserting a new full-width row because it keeps the panel compact
       * and visually balanced; HotFilesList renders null when empty, in which case the
       * column collapses gracefully (flex-1 only allocates space when there is content).
       */}
      <div className="flex gap-4">
        <div className="flex-1 min-w-0">
          <HotFilesList files={stats.hot_files} />
        </div>
        <div className="flex-1 min-w-0">
          {stats.error_groups.length > 0 ? (
            <ErrorGroupsList
              groups={stats.error_groups}
              onGroupClick={onErrorGroupClick}
              toolFilter={toolFilter}
              errorsOnly={errorsOnly}
            />
          ) : (
            <div
              className="text-[11px] leading-[13px]"
              style={{ color: 'var(--label-secondary)' }}
            >
              No errors in this window.
            </div>
          )}
        </div>
        <div style={{ width: 140, flexShrink: 0 }}>
          <Sparkline
            byMinute={stats.by_minute}
            windowMs={windowMs}
            onSelectRange={onSelectRange}
            activeRange={timeRange}
          />
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

// ── localStorage keys for filter & control persistence ───────────────────
const TOOL_FILTER_STORAGE_KEY = 'toolactivity.tools';
const ERRORS_ONLY_STORAGE_KEY = 'toolactivity.errorsOnly';
const GROUP_BY_SESSION_STORAGE_KEY = 'toolactivity.groupBySession';

function loadToolFilter(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(TOOL_FILTER_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === 'string'));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

function loadErrorsOnly(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ERRORS_ONLY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function loadGroupBySession(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(GROUP_BY_SESSION_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

// ── Session group sub-component ───────────────────────────────────────────

interface SessionGroup {
  session_id: string;
  entries: JournalEntry[];
  earliest_ts: number;
  latest_ts: number;
  error_count: number;
}

/**
 * Buckets entries by session_id, preserving the input ordering within each
 * group (which is newest-first because the feed is newest-first). Groups are
 * returned sorted by latest_ts descending so the most-recently-active session
 * surfaces at the top.
 */
function groupEntriesBySession(entries: JournalEntry[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const e of entries) {
    let g = map.get(e.session_id);
    if (g === undefined) {
      g = {
        session_id: e.session_id,
        entries: [],
        earliest_ts: e.ts,
        latest_ts: e.ts,
        error_count: 0,
      };
      map.set(e.session_id, g);
    }
    g.entries.push(e);
    if (e.ts < g.earliest_ts) g.earliest_ts = e.ts;
    if (e.ts > g.latest_ts) g.latest_ts = e.ts;
    if (e.is_error) g.error_count++;
  }
  return [...map.values()].sort((a, b) => b.latest_ts - a.latest_ts);
}

function formatGroupTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function SessionGroupHeader({
  group,
  collapsed,
  onToggle,
}: {
  group: SessionGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const shortId = `${group.session_id.slice(0, 8)}…`;
  const fromTime = formatGroupTime(group.earliest_ts);
  const toTime = formatGroupTime(group.latest_ts);
  return (
    <button
      type="button"
      onClick={onToggle}
      title={group.session_id}
      className="w-full flex items-center gap-2 px-3 text-left"
      aria-expanded={!collapsed}
      style={{
        background: 'var(--fill-quaternary)',
        border: 'none',
        borderBottom: '0.5px solid var(--separator)',
        cursor: 'pointer',
        height: 28,
        fontSize: 11,
        lineHeight: '13px',
        color: 'var(--label-secondary)',
      }}
    >
      <span className="flex shrink-0" style={{ color: 'var(--label-secondary)' }}>
        <Icon name={collapsed ? 'chevron_right' : 'expand_more'} size={14} />
      </span>
      <span style={{ color: 'var(--label)', fontFamily: 'var(--font-mono)' }}>{shortId}</span>
      <span className="tabular-nums">
        {group.entries.length} call{group.entries.length === 1 ? '' : 's'}
      </span>
      <span className="tabular-nums">
        {fromTime} – {toTime}
      </span>
      {group.error_count > 0 && (
        <span className="ml-auto">
          <Badge tone="red" icon="warning">
            {group.error_count} error{group.error_count === 1 ? '' : 's'}
          </Badge>
        </span>
      )}
    </button>
  );
}

// ── Keyboard help overlay ─────────────────────────────────────────────────

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: '/', desc: 'Focus search' },
  { keys: '↓ / j', desc: 'Next call' },
  { keys: '↑ / k', desc: 'Previous call' },
  { keys: '⏎', desc: 'Expand or collapse the selected call' },
  { keys: 'Esc', desc: 'Clear the search, then the filters, then the selection' },
  { keys: '?', desc: 'Show or hide this list' },
];

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgb(0 0 0 / 0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
        style={{
          background: 'var(--surface-raised)',
          border: '0.5px solid var(--separator)',
          borderRadius: 'var(--radius-panel)',
          padding: '16px 20px',
          minWidth: 320,
          maxWidth: 420,
          boxShadow: 'var(--shadow-panel)',
        }}
      >
        <div
          className="text-[17px] leading-[22px] font-semibold mb-3"
          style={{ color: 'var(--label)' }}
        >
          Keyboard shortcuts
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '8px 12px',
            alignItems: 'center',
            fontSize: 13,
            lineHeight: '16px',
            color: 'var(--label)',
          }}
        >
          {SHORTCUTS.map((s) => (
            <div key={s.keys} style={{ display: 'contents' }}>
              <kbd
                style={{
                  display: 'inline-block',
                  minWidth: 24,
                  textAlign: 'center',
                  padding: '2px 6px',
                  borderRadius: 6,
                  background: 'var(--fill-quaternary)',
                  boxShadow: 'inset 0 0 0 0.5px var(--separator)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--label)',
                }}
              >
                {s.keys}
              </kbd>
              <span style={{ color: 'var(--label-secondary)' }}>{s.desc}</span>
            </div>
          ))}
        </div>
        <div className="text-[11px] leading-[13px] mt-4" style={{ color: 'var(--label-secondary)' }}>
          Press Esc or ? to close.
        </div>
      </div>
    </div>
  );
}

export function ToolActivity({
  root,
  subTab,
  onOpenFileInGraph,
}: {
  root: string;
  /** The Tool calls | AI calls switcher. Rendered INTO this surface's toolbar
      rather than above it — two stacked control rows is what TRA-294 exists to
      remove, and the switcher belongs on the leading edge of the one bar. */
  subTab?: ReactNode;
  onOpenFileInGraph?: (filePath: string) => void;
}) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  // Multi-select tool filter — empty set means "no tool restriction".
  const [toolFilter, setToolFilter] = useState<Set<string>>(() => loadToolFilter());
  // Combinable errors-only toggle, independent of tool filter.
  const [errorsOnly, setErrorsOnly] = useState<boolean>(() => loadErrorsOnly());
  // Group flat list by session_id when on. Persisted.
  const [groupBySession, setGroupBySession] = useState<boolean>(() => loadGroupBySession());
  // Collapsed session ids when grouping is on. Not persisted — refresh resets
  // to all expanded, matching the spec.
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(new Set());
  // Ephemeral text search across params_summary + tool. Not persisted.
  const [query, setQuery] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Keyboard navigation state ────────────────────────────────────────
  // Index into the currently-visible `filtered` list (flat order, regardless
  // of group-by-session). -1 means no selection.
  const [selectedIdx, setSelectedIdx] = useState<number>(-1);
  // Expand state lifted out of EntryRow so Enter can toggle the selected row.
  // Keyed by entryKey(entry) so it survives re-renders and list churn.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  // Keyboard-shortcuts help overlay.
  const [showHelp, setShowHelp] = useState(false);
  // Ref to the search input so "/" can focus it and Escape can blur it.
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Toolbar scroll-edge hairline — content scrolls UNDER the bar, so the rule
  // appears on scroll instead of being painted permanently.
  const [scrolled, setScrolled] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const overflow = useMenuAnchor();

  // ── Pause / clear / export local controls ────────────────────────────
  const [paused, setPaused] = useState(false);
  // Mirror of `paused` for the long-lived SSE onmessage closure to avoid
  // re-subscribing every time the user toggles the button.
  const pausedRef = useRef(false);
  // While paused, incoming SSE entries accumulate here and flush on resume.
  const pausedBufferRef = useRef<JournalEntry[]>([]);
  // Re-render trigger for the "Paused (N)" badge counter.
  const [pausedBufferTick, setPausedBufferTick] = useState(0);

  // ── Stats state ──────────────────────────────────────────────────────
  const [stats, setStats] = useState<JournalStats | null>(null);
  // Immediately-preceding window of the same size, for the "vs previous" deltas.
  // Best-effort: a failed prev fetch leaves this as-is rather than blanking it.
  const [prevStats, setPrevStats] = useState<JournalStats | null>(null);
  const [statsExpanded, setStatsExpanded] = useState(true);
  // Active stats window, persisted in localStorage.
  const [windowMs, setWindowMs] = useState<number>(() => loadWindowMs());
  // Client-side feed time-range filter, driven by dragging across the
  // sparkline. Null = no range filter. Does NOT affect the server stats window.
  const [timeRange, setTimeRange] = useState<{ start: number; end: number } | null>(null);
  // Live incremental counters between server reconciliations
  const liveCountsRef = useRef({ calls: 0, errors: 0 });

  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the user has scrolled away from the top (newest entries)
  const userScrolledRef = useRef(false);

  // ── Fetch aggregated stats ────────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    // Current window — ends at "now" (no `before` param).
    const curParams = new URLSearchParams({
      project: root,
      window: String(windowMs),
    });
    // Previous window of the same size — ends where the current window starts.
    const prevParams = new URLSearchParams({
      project: root,
      window: String(windowMs),
      before: String(Date.now() - windowMs),
    });

    const curFetch = (async () => {
      try {
        const res = await fetch(`${BASE}/api/projects/journal/stats?${curParams}`);
        if (res.ok) {
          const data = (await res.json()) as JournalStats;
          setStats(data);
          // Reset live increment counters after a server reconciliation
          liveCountsRef.current = { calls: 0, errors: 0 };
        }
      } catch {
        /* stats are best-effort — silently skip on network error */
      }
    })();

    // Previous-window fetch is independent: a failure must NOT blank the
    // current stats, so it has its own try/catch and leaves prevStats as-is.
    const prevFetch = (async () => {
      try {
        const res = await fetch(`${BASE}/api/projects/journal/stats?${prevParams}`);
        if (res.ok) {
          const data = (await res.json()) as JournalStats;
          setPrevStats(data);
        }
      } catch {
        /* baseline is best-effort — keep the last good prevStats on error */
      }
    })();

    // Run both in parallel; each settles independently.
    await Promise.all([curFetch, prevFetch]);
  }, [root, windowMs]);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, STATS_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStats]);

  // Persist window selection
  const handleWindowChange = useCallback((ms: number) => {
    setWindowMs(ms);
    try {
      window.localStorage.setItem(WINDOW_STORAGE_KEY, String(ms));
    } catch {
      /* localStorage may be unavailable (private mode, quota) — ignore */
    }
  }, []);

  // Persist filter state across refresh.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        TOOL_FILTER_STORAGE_KEY,
        JSON.stringify(Array.from(toolFilter)),
      );
    } catch {
      /* localStorage may be unavailable — ignore */
    }
  }, [toolFilter]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ERRORS_ONLY_STORAGE_KEY, errorsOnly ? '1' : '0');
    } catch {
      /* localStorage may be unavailable — ignore */
    }
  }, [errorsOnly]);

  useEffect(() => {
    try {
      window.localStorage.setItem(GROUP_BY_SESSION_STORAGE_KEY, groupBySession ? '1' : '0');
    } catch {
      /* localStorage may be unavailable — ignore */
    }
  }, [groupBySession]);

  // Toggle collapsed state for a single session group. New entries arriving
  // for a collapsed session do NOT auto-expand it; the user re-opens manually.
  const handleToggleSessionCollapsed = useCallback((sessionId: string) => {
    setCollapsedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  // Toggle expand for a single entry (by its stable key). Used by both the
  // row's own click and the keyboard Enter shortcut.
  const toggleExpandKey = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Fetch initial history ────────────────────────────────────────────

  const fetchHistory = useCallback(async () => {
    try {
      const params = new URLSearchParams({ project: root, limit: '200' });
      const res = await fetch(`${BASE}/api/projects/journal?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      {
        const data = (await res.json()) as JournalEntry[];
        // Snapshot is newest-first already (server sorts that way)
        setEntries((prev) => {
          const merged = [...data, ...prev];
          // Deduplicate by ts+tool+session_id
          const seen = new Set<string>();
          const deduped: JournalEntry[] = [];
          for (const e of merged) {
            const key = `${e.ts}:${e.tool}:${e.session_id}`;
            if (!seen.has(key)) {
              seen.add(key);
              deduped.push(e);
            }
          }
          return deduped.slice(0, MAX_ENTRIES);
        });
      }
      setHistoryFailed(false);
    } catch {
      /* Live SSE is the primary source, so a failed history fetch is not fatal
         — but it must not read as "no calls yet". That sent you off to connect
         a client that was already connected (TRA-294). */
      setHistoryFailed(true);
    }
  }, [root]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // ── SSE subscription ─────────────────────────────────────────────────

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    function connect() {
      es = new EventSource(`${BASE}/api/events`);

      es.onopen = () => {
        if (!closed) {
          setConnected(true);
          setError(null);
        }
      };

      es.onmessage = (evt: MessageEvent) => {
        if (closed) return;
        try {
          const data = JSON.parse(evt.data as string) as Record<string, unknown>;
          if (data.type !== 'journal_entry') return;
          if (data.project !== root) return;

          const entry = data as unknown as JournalEntry;

          // If the user has paused the live feed, divert incoming entries into
          // a buffer; the rest of the per-entry pipeline (stats counters,
          // scroll behaviour) is skipped until resume.
          if (pausedRef.current) {
            pausedBufferRef.current = [entry, ...pausedBufferRef.current].slice(0, MAX_ENTRIES);
            setPausedBufferTick((t) => t + 1);
            return;
          }

          setEntries((prev) => {
            const next = [entry, ...prev];
            return next.slice(0, MAX_ENTRIES);
          });

          // Increment live counters so the summary bar stays fresh
          // between 30-s server reconciliations
          liveCountsRef.current.calls++;
          if (entry.is_error) liveCountsRef.current.errors++;
          setStats((prev) => {
            if (!prev) return prev;
            // Cheaply bump total_calls and error_rate without recomputing
            // the full histogram — server reconciliation handles precision.
            const newTotal = prev.total_calls + 1;
            const newErrors = Math.round(prev.error_rate * prev.total_calls) + (entry.is_error ? 1 : 0);
            return {
              ...prev,
              total_calls: newTotal,
              error_rate: newTotal > 0 ? newErrors / newTotal : 0,
            };
          });

          // Auto-scroll to top unless user has scrolled down
          if (!userScrolledRef.current && scrollRef.current) {
            scrollRef.current.scrollTop = 0;
          }
        } catch {
          /* ignore malformed events */
        }
      };

      es.onerror = () => {
        if (closed) return;
        setConnected(false);
        setError('SSE connection lost — reconnecting…');
        es?.close();
        // Reconnect after 3s
        setTimeout(() => {
          if (!closed) connect();
        }, 3000);
      };
    }

    connect();
    return () => {
      closed = true;
      es?.close();
      setConnected(false);
    };
  }, [root]);

  // ── Scroll tracking ──────────────────────────────────────────────────

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // If user scrolled more than 60px from top, mark as "scrolled away"
    userScrolledRef.current = el.scrollTop > 60;
    // Separate threshold: the toolbar's hairline fades in the moment content
    // slides under it, which is at the first pixel, not at 60.
    setScrolled(el.scrollTop > 0);
  }, []);

  // ── Filter callbacks wired to stats panel ─────────────────────────────

  // Clicking a hot tool toggles membership in the multi-select set.
  const handleToolClick = useCallback(
    (tool: string) => {
      setToolFilter((prev) => {
        const next = new Set(prev);
        if (next.has(tool)) next.delete(tool);
        else next.add(tool);
        return next;
      });
    },
    [],
  );

  // Clicking an error group adds the tool to the multi-select AND enables
  // errors-only. Clicking again on the same active+errors-only state clears
  // that tool's selection and turns errors-only off (so the user gets back
  // to the unfiltered view in a single click).
  const handleErrorGroupClick = useCallback(
    (tool: string) => {
      setToolFilter((prev) => {
        const isActive = errorsOnly && prev.has(tool);
        const next = new Set(prev);
        if (isActive) next.delete(tool);
        else next.add(tool);
        return next;
      });
      setErrorsOnly((prev) => {
        const wasActive = prev && toolFilter.has(tool);
        return wasActive ? false : true;
      });
    },
    [errorsOnly, toolFilter],
  );

  // ── Pause / Clear / Export handlers ───────────────────────────────────

  const handleTogglePause = useCallback(() => {
    setPaused((prev) => {
      const next = !prev;
      pausedRef.current = next;
      if (!next) {
        // Resuming — flush buffered entries into the live list,
        // deduplicated against existing entries.
        const buffered = pausedBufferRef.current;
        if (buffered.length > 0) {
          setEntries((cur) => {
            const seen = new Set<string>();
            const deduped: JournalEntry[] = [];
            for (const e of [...buffered, ...cur]) {
              const key = `${e.ts}:${e.tool}:${e.session_id}`;
              if (!seen.has(key)) {
                seen.add(key);
                deduped.push(e);
              }
            }
            return deduped.slice(0, MAX_ENTRIES);
          });
          // Bump live counters so the stats bar reflects the burst.
          for (const e of buffered) {
            liveCountsRef.current.calls++;
            if (e.is_error) liveCountsRef.current.errors++;
          }
        }
        pausedBufferRef.current = [];
        setPausedBufferTick(0);
      }
      return next;
    });
  }, []);

  const handleClear = useCallback(() => {
    if (!window.confirm('Clear local activity buffer?')) return;
    setEntries([]);
  }, []);

  const handleExport = useCallback(() => {
    // `filtered` is captured below; compute the same predicate here so the
    // export reflects the visible feed without coupling render order.
    const exportable = entries.filter((e) => {
      if (errorsOnly && !e.is_error) return false;
      if (toolFilter.size > 0 && !toolFilter.has(e.tool)) return false;
      const q = query.trim().toLowerCase();
      if (q !== '') {
        if (
          !e.params_summary.toLowerCase().includes(q) &&
          !e.tool.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
    const body = exportable.map((e) => JSON.stringify(e)).join('\n');
    const blob = new Blob([body], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tail = root.split('/').pop() ?? 'project';
    a.href = url;
    a.download = `activity-${tail}-${stamp}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [entries, errorsOnly, toolFilter, query, root]);

  // ── Filtering ────────────────────────────────────────────────────────

  const top5 = topTools(entries, 5);

  // Errors-only, the multi-select tool filter, and the sparkline time-range
  // combine multiplicatively, then the free-text query narrows on top. The
  // time-range filter is client-side only (it does not change the server stats
  // window) and is folded in here so keyboard selection and session grouping
  // all operate on the same visible list.
  let chipFiltered = entries;
  if (errorsOnly) chipFiltered = chipFiltered.filter((e) => e.is_error);
  if (toolFilter.size > 0) chipFiltered = chipFiltered.filter((e) => toolFilter.has(e.tool));
  if (timeRange !== null) {
    chipFiltered = chipFiltered.filter(
      (e) => e.ts >= timeRange.start && e.ts <= timeRange.end,
    );
  }

  const queryLower = query.trim().toLowerCase();
  const filtered =
    queryLower === ''
      ? chipFiltered
      : chipFiltered.filter(
          (e) =>
            e.params_summary.toLowerCase().includes(queryLower) ||
            e.tool.toLowerCase().includes(queryLower),
        );

  // ── Toolbar-derived state ────────────────────────────────────────────
  // "Filters" are what the ••• menu and the sparkline set; the free-text query
  // is not one of them (it has its own field with its own clear button).
  const activeFilterCount =
    (errorsOnly ? 1 : 0) + toolFilter.size + (timeRange !== null ? 1 : 0);

  const clearFilters = useCallback(() => {
    setErrorsOnly(false);
    setToolFilter(new Set());
    setTimeRange(null);
  }, []);

  /** How many calls the filters are holding back — the number the empty state
      needs to say "clear them" honestly. */
  const filteredOutCount = entries.length - filtered.length;

  const feedTone = paused ? 'orange' : connected ? 'green' : 'neutral';
  const feedLabel = paused
    ? `Paused (${pausedBufferRef.current.length})`
    : connected
      ? 'Live'
      : 'Offline';

  // Keep the selected index within bounds as the visible list shrinks/grows.
  // (e.g. a new filter trims the list below the previously-selected index.)
  useEffect(() => {
    if (selectedIdx >= filtered.length) {
      setSelectedIdx(filtered.length > 0 ? filtered.length - 1 : -1);
    }
  }, [filtered.length, selectedIdx]);

  // Scroll the selected row into view whenever the selection moves.
  useEffect(() => {
    if (selectedIdx < 0) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-entry-idx="${selectedIdx}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // ── Keyboard navigation ───────────────────────────────────────────────
  // Single window-level keydown listener. Guarded so typing in the search
  // input doesn't trigger shortcuts — except Escape, which still blurs/clears.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const inInput = document.activeElement?.tagName === 'INPUT';

      // Escape works everywhere, including while typing in the search box.
      if (e.key === 'Escape') {
        if (showHelp) {
          setShowHelp(false);
          return;
        }
        // (a) search focused → blur it
        if (inInput && document.activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
          return;
        }
        // (b) query non-empty → clear query
        if (query !== '') {
          setQuery('');
          return;
        }
        // (c) any filter active → clear filters (tool/errors chips AND the
        //     sparkline time-range, which is treated as a special filter)
        if (toolFilter.size > 0 || errorsOnly || timeRange !== null) {
          setToolFilter(new Set());
          setErrorsOnly(false);
          setTimeRange(null);
          return;
        }
        // (d) an entry is selected → deselect
        if (selectedIdx >= 0) {
          setSelectedIdx(-1);
        }
        return;
      }

      // All other shortcuts are suppressed while typing in an input.
      if (inInput) return;

      switch (e.key) {
        case '/':
          e.preventDefault();
          searchInputRef.current?.focus();
          break;
        // ↑↓ is what a Mac list responds to; j/k stay for the vim hands.
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          setSelectedIdx((i) =>
            filtered.length === 0 ? -1 : Math.min(i + 1, filtered.length - 1),
          );
          break;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          setSelectedIdx((i) => (filtered.length === 0 ? -1 : Math.max(i - 1, 0)));
          break;
        case 'Enter':
          if (selectedIdx >= 0 && selectedIdx < filtered.length) {
            e.preventDefault();
            toggleExpandKey(entryKey(filtered[selectedIdx]));
          }
          break;
        case '?':
          // Shift+/ produces "?"; toggle the help overlay.
          e.preventDefault();
          setShowHelp((v) => !v);
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filtered, selectedIdx, query, toolFilter, errorsOnly, timeRange, showHelp, toggleExpandKey]);

  // Map entryKey → flat index in `filtered`, so the grouped render path (which
  // maps over per-session buckets) can resolve each row's selection index.
  const flatIdxByKey = new Map<string, number>();
  filtered.forEach((e, i) => {
    flatIdxByKey.set(entryKey(e), i);
  });

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ color: 'var(--label)', position: 'relative' }}
    >
      {/* ── Toolbar ───────────────────────────────────────────────────
          ONE row. Before TRA-294 this surface stacked three: a right-aligned
          floating cluster (● Live · N calls · ⏸ · ⌫ · ⤓) in bare whitespace,
          then a "Group by session" pill beside a search box, then an
          All | Errors chip row. Everything that is not the source switch, the
          feed state or the search now lives behind the overflow menu. */}
      <Toolbar scrolled={scrolled}>
        {subTab}

        <ToolbarDivider />

        {/* Feed state. The dot is a tone; the word next to it is the state —
            "Live" and "Paused" have to survive without colour. */}
        <span
          className="flex items-center gap-1.5 shrink-0 text-[11px] leading-[13px]"
          style={{ color: 'var(--label-secondary)' }}
        >
          <StatusDot tone={feedTone} pulse={feedTone === 'green'} />
          <span style={{ color: 'var(--label)' }}>{feedLabel}</span>
          <span className="tabular-nums">
            · {entries.length.toLocaleString()} call{entries.length === 1 ? '' : 's'}
          </span>
        </span>

        <span className="flex-1" />

        {/* Active filters read as removable tokens rather than a permanent
            chip row that is empty most of the time. */}
        {activeFilterCount > 0 && (
          <Button
            variant="bordered"
            className="is-on shrink-0"
            icon="close"
            onClick={clearFilters}
            title="Clear all filters"
          >
            {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
          </Button>
        )}

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search calls"
          aria-label="Search calls"
          inputRef={searchInputRef}
        />

        <Button
          variant="icon"
          icon={paused ? 'play_arrow' : 'pause'}
          onClick={handleTogglePause}
          aria-pressed={paused}
          aria-label={paused ? 'Resume the live feed' : 'Pause the live feed'}
          title={paused ? 'Resume the live feed' : 'Pause the live feed'}
        />

        <Button
          ref={overflow.ref}
          variant="icon"
          icon="more_horiz"
          onClick={() => (overflow.at ? overflow.close() : overflow.open())}
          aria-haspopup="menu"
          aria-expanded={overflow.at !== null}
          aria-label="More actions"
          title="More actions"
        />
      </Toolbar>

      {overflow.at && (
        <Menu x={overflow.at.x} y={overflow.at.y} align="end" onClose={overflow.close}>
          <MenuItem
            showCheckSlot
            checked={errorsOnly}
            onClick={() => setErrorsOnly((v) => !v)}
          >
            Errors only
          </MenuItem>
          <MenuItem
            showCheckSlot
            checked={groupBySession}
            onClick={() => setGroupBySession((v) => !v)}
          >
            Group by session
          </MenuItem>
          {top5.length > 0 && (
            <>
              <MenuSection>Tools</MenuSection>
              {top5.map((tool) => (
                <MenuItem
                  key={tool}
                  showCheckSlot
                  checked={toolFilter.has(tool)}
                  onClick={() => handleToolClick(tool)}
                >
                  {tool}
                </MenuItem>
              ))}
            </>
          )}
          {activeFilterCount > 0 && (
            <>
              <MenuSeparator />
              <MenuItem
                icon="close"
                onClick={() => {
                  clearFilters();
                  overflow.close();
                }}
              >
                Clear filters
              </MenuItem>
            </>
          )}
          <MenuSeparator />
          <MenuItem
            icon="download"
            disabled={filtered.length === 0}
            onClick={() => {
              handleExport();
              overflow.close();
            }}
          >
            Export {filtered.length.toLocaleString()} call
            {filtered.length === 1 ? '' : 's'} as JSONL
          </MenuItem>
          <MenuItem
            danger
            icon="trash"
            disabled={entries.length === 0}
            onClick={() => {
              handleClear();
              overflow.close();
            }}
          >
            Clear the local feed
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="tune"
            shortcut="?"
            onClick={() => {
              setShowHelp(true);
              overflow.close();
            }}
          >
            Keyboard shortcuts
          </MenuItem>
        </Menu>
      )}

      {/* ── Stats panel (collapsible) ── */}
      {/* Stats summary bar — always visible when stats are loaded */}
      {stats !== null && (
        <StatsSummaryBar
          stats={stats}
          prevStats={prevStats}
          expanded={statsExpanded}
          onToggle={() => setStatsExpanded((v) => !v)}
          windowMs={windowMs}
          onWindowChange={handleWindowChange}
        />
      )}
      {/* Expanded stats body — inserted between header and live feed */}
      {stats !== null && statsExpanded && (
        <StatsPanel
          stats={stats}
          onToolClick={handleToolClick}
          onErrorGroupClick={handleErrorGroupClick}
          toolFilter={toolFilter}
          errorsOnly={errorsOnly}
          windowMs={windowMs}
          onSelectRange={setTimeRange}
          timeRange={timeRange}
        />
      )}

      {/* ── Error banner ── */}
      {error && (
        <div
          role="status"
          className="shrink-0 flex items-center gap-2 px-4 py-2 text-[13px] leading-4"
          style={{
            background: 'color-mix(in oklab, var(--status-red) 8%, transparent)',
            color: 'var(--status-red)',
            borderBottom: '0.5px solid var(--separator)',
          }}
        >
          <Icon name="warning" size={14} />
          {error}
        </div>
      )}

      {/* ── Entry list ── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ background: 'var(--surface)' }}
      >
        {filtered.length === 0 ? (
          historyFailed && activeFilterCount === 0 && query === '' ? (
            <EmptyState
              icon="warning"
              iconSize={32}
              title="Can't reach the indexer"
              subtitle="The trace-mcp daemon didn't answer, so this project's earlier calls couldn't be loaded. Anything new still arrives live."
              action={<Button icon="refresh" onClick={() => void fetchHistory()}>Try again</Button>}
            />
          ) : activeFilterCount === 0 && query === '' ? (
            <EmptyState
              icon="monitoring"
              iconSize={32}
              title="No tool calls yet"
              subtitle="Every trace-mcp call an assistant makes against this project lands here, live. Connect a client to start the feed."
              action={
                <Button
                  variant="prominent"
                  icon="plugins"
                  onClick={() => void window.electronAPI?.openClients?.()}
                >
                  Connect a client
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon="search"
              iconSize={32}
              title="No matching calls"
              subtitle={
                activeFilterCount > 0
                  ? `${filteredOutCount.toLocaleString()} call${filteredOutCount === 1 ? '' : 's'} are hidden by the current filters.`
                  : 'Nothing in the feed matches that search.'
              }
              action={
                <Button
                  icon="close"
                  onClick={() => {
                    clearFilters();
                    setQuery('');
                  }}
                >
                  Clear filters and search
                </Button>
              }
            />
          )
        ) : groupBySession ? (
          groupEntriesBySession(filtered).map((group) => {
            const collapsed = collapsedSessions.has(group.session_id);
            return (
              <div key={group.session_id}>
                <SessionGroupHeader
                  group={group}
                  collapsed={collapsed}
                  onToggle={() => handleToggleSessionCollapsed(group.session_id)}
                />
                {!collapsed &&
                  group.entries.map((entry) => {
                    const key = entryKey(entry);
                    const idx = flatIdxByKey.get(key) ?? -1;
                    return (
                      <EntryRow
                        key={key}
                        entry={entry}
                        query={query}
                        indent={12}
                        entryIdx={idx}
                        isSelected={idx === selectedIdx}
                        expanded={expandedKeys.has(key)}
                        onToggleExpand={() => {
                          setSelectedIdx(idx);
                          toggleExpandKey(key);
                        }}
                        onOpenFileInGraph={onOpenFileInGraph}
                      />
                    );
                  })}
              </div>
            );
          })
        ) : (
          filtered.map((entry, idx) => {
            const key = entryKey(entry);
            return (
              <EntryRow
                key={key}
                entry={entry}
                query={query}
                entryIdx={idx}
                isSelected={idx === selectedIdx}
                expanded={expandedKeys.has(key)}
                onToggleExpand={() => {
                  setSelectedIdx(idx);
                  toggleExpandKey(key);
                }}
                onOpenFileInGraph={onOpenFileInGraph}
              />
            );
          })
        )}
      </div>
      {showHelp && <ShortcutsHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}
