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
    background: 'var(--accent-soft, rgba(0,122,255,0.18))',
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
  while ((m = FILE_PATH_RE.exec(text)) !== null) {
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
  let color = 'var(--text-tertiary)';
  if (higherIsBad && delta.direction !== 'flat') {
    color = delta.direction === 'up' ? 'var(--red, #ef4444)' : 'var(--success, #22c55e)';
  }
  const glyph = delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '';
  const title = `vs previous ${windowLabel(windowMs)}: ${prevLabel} → ${curLabel}${unit ? ` ${unit}` : ''}`;
  return (
    <span
      className="tabular-nums"
      style={{ fontSize: 9, color, marginLeft: 3, whiteSpace: 'nowrap' }}
      title={title}
    >
      {glyph}
      {delta.text}
    </span>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function ToolBadge({ tool, isError }: { tool: string; isError: boolean }) {
  const bg = isError ? 'rgba(239,68,68,0.15)' : 'rgba(0,122,255,0.1)';
  const color = isError ? 'var(--red, #ef4444)' : 'var(--accent, #007aff)';
  return (
    <span
      className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap"
      style={{ background: bg, color }}
    >
      {tool}
    </span>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11px] px-2.5 py-1 rounded-full transition-all shrink-0"
      style={{
        background: active ? 'var(--accent)' : 'var(--bg-inset)',
        color: active ? '#fff' : 'var(--text-secondary)',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        border: 'none',
      }}
    >
      {label}
    </button>
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

  const rowBg = entry.is_error ? 'rgba(239,68,68,0.06)' : 'transparent';
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
        borderBottom: '0.5px solid var(--border-row)',
        background: isSelected ? 'var(--bg-active)' : rowBg,
        paddingLeft: indent,
        borderLeft: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
      }}
    >
      {/* Collapsed row — clickable */}
      <button
        type="button"
        onClick={() => onToggleExpand?.()}
        className="flex items-start gap-2.5 px-3 py-2 w-full text-left"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          minHeight: 36,
          transition: 'background .1s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-active)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'none';
        }}
      >
        {/* Relative time */}
        <span
          className="shrink-0 text-[10px] tabular-nums mt-0.5 w-14 text-right"
          style={{ color: 'var(--text-tertiary)', fontFamily: 'SF Mono, Menlo, monospace' }}
        >
          {relativeTime(entry.ts)}
        </span>

        {/* Tool badge */}
        <ToolBadge tool={entry.tool} isError={entry.is_error} />

        {/* Params summary */}
        <div className="flex-1 min-w-0">
          <div
            className="text-[12px] truncate leading-snug"
            style={{
              color: entry.is_error ? 'var(--red, #ef4444)' : 'var(--text-primary)',
              fontFamily: 'SF Mono, Menlo, monospace',
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
                className="ml-2 text-[10px]"
                style={{
                  color: 'var(--success, #22c55e)',
                  fontFamily: 'inherit',
                  transition: 'opacity .3s',
                }}
                title={recentlyCopied}
              >
                Copied
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {entry.result_count} result{entry.result_count === 1 ? '' : 's'}
            </span>
            {entry.latency_ms !== undefined && (
              <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                {entry.latency_ms < 1000
                  ? `${entry.latency_ms}ms`
                  : `${(entry.latency_ms / 1000).toFixed(1)}s`}
              </span>
            )}
            {entry.result_tokens !== undefined && (
              <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                ~{entry.result_tokens} tok
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            padding: '4px 12px 8px 76px',
            fontSize: 11,
            fontFamily: 'SF Mono, Menlo, monospace',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '2px 10px',
            color: 'var(--text-secondary)',
          }}
        >
          <span style={{ color: 'var(--text-tertiary)' }}>Time</span>
          <span>{absoluteTime}</span>

          <span style={{ color: 'var(--text-tertiary)' }}>Session</span>
          <span style={{ wordBreak: 'break-all' }}>{entry.session_id}</span>

          <span style={{ color: 'var(--text-tertiary)' }}>Tool</span>
          <span style={{ wordBreak: 'break-all' }}>{entry.tool}</span>

          <span style={{ color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            Params
            <button
              type="button"
              onClick={handleCopyParams}
              style={{
                fontSize: 9,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'var(--bg-inset)',
                color: 'var(--text-secondary)',
                border: '0.5px solid var(--border-row)',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
              title="Copy full params to clipboard"
            >
              Copy
            </button>
          </span>
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {entry.params_summary}
          </span>

          <span style={{ color: 'var(--text-tertiary)' }}>Results</span>
          <span>{entry.result_count}</span>

          {entry.latency_ms !== undefined && (
            <>
              <span style={{ color: 'var(--text-tertiary)' }}>Latency</span>
              <span>{entry.latency_ms}ms</span>
            </>
          )}

          {entry.result_tokens !== undefined && (
            <>
              <span style={{ color: 'var(--text-tertiary)' }}>Tokens</span>
              <span>{entry.result_tokens}</span>
            </>
          )}

          {entry.is_error && (
            <>
              <span style={{ color: 'var(--red, #ef4444)' }}>Error</span>
              <span style={{ color: 'var(--red, #ef4444)' }}>This call returned an error.</span>
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
      ? 'var(--red, #ef4444)'
      : stats.error_rate > 0.02
        ? 'var(--orange, #f97316)'
        : 'var(--text-secondary)';

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
      className="w-full flex items-center gap-3 px-3 py-1.5 text-left"
      style={{
        background: 'var(--bg-inset)',
        border: 'none',
        borderBottom: '0.5px solid var(--border-row)',
        cursor: 'pointer',
      }}
    >
      <span className="text-[10px] font-semibold" style={{ color: 'var(--text-tertiary)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        Stats
      </span>
      {/* Window picker — segmented control, click does not toggle the bar */}
      <div
        className="flex items-center gap-0.5"
        onClick={stopBubble}
        onKeyDown={stopBubble}
        role="group"
        aria-label="Stats window"
      >
        {WINDOW_OPTIONS.map((opt) => {
          const isActive = windowMs === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onWindowChange(opt.value);
              }}
              className="text-[10px] tabular-nums"
              style={{
                padding: '2px 6px',
                borderRadius: 999,
                border: isActive ? '0.5px solid var(--accent, #007aff)' : '0.5px solid var(--border-row)',
                background: isActive ? 'var(--accent, #007aff)' : 'var(--fill-control, transparent)',
                color: isActive ? 'white' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontWeight: isActive ? 600 : 400,
              }}
              title={`Show stats for the last ${opt.label}`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-primary)' }}>
        <span className="font-semibold tabular-nums">{stats.total_calls.toLocaleString()}</span>
        <span style={{ color: 'var(--text-tertiary)' }}>calls</span>
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
      <span className="flex items-center gap-1 text-[11px]" style={{ color: errorColor }}>
        <span className="font-semibold tabular-nums">{errorPct}%</span>
        <span style={{ color: 'var(--text-tertiary)' }}>err</span>
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
      <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-primary)' }}>
        <span className="font-semibold tabular-nums">{p95}</span>
        <span style={{ color: 'var(--text-tertiary)' }}>p95</span>
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
      <span className="ml-auto text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        {expanded ? '▲' : '▼'}
      </span>
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
      <div className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Hot Tools
      </div>
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
                className="shrink-0 text-[10px] tabular-nums w-24 truncate"
                style={{
                  color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                  fontWeight: isActive ? 600 : 400,
                  fontFamily: 'SF Mono, Menlo, monospace',
                }}
              >
                {t.tool}
              </span>
              <div className="flex-1 relative h-3 rounded-sm overflow-hidden" style={{ background: 'var(--bg-grouped)' }}>
                <div
                  className="absolute inset-y-0 left-0 rounded-sm"
                  style={{
                    width: `${pct}%`,
                    background: hasErrors
                      ? 'linear-gradient(90deg, var(--accent, #007aff), var(--red, #ef4444))'
                      : 'var(--accent, #007aff)',
                    opacity: isActive ? 1 : 0.6,
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              <span className="shrink-0 text-[10px] tabular-nums w-7 text-right" style={{ color: 'var(--text-tertiary)' }}>
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
      <div
        className="text-[10px] font-semibold mb-1.5"
        style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}
      >
        Hot Files
      </div>
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
                className="shrink-0 text-[10px] tabular-nums w-32 truncate"
                style={{
                  color: 'var(--text-primary)',
                  fontFamily: 'SF Mono, Menlo, monospace',
                }}
              >
                {displayPath}
              </span>
              <div
                className="flex-1 relative h-3 rounded-sm overflow-hidden"
                style={{ background: 'var(--bg-grouped)' }}
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-sm"
                  style={{
                    width: `${pct}%`,
                    background: 'var(--accent, #007aff)',
                    opacity: 0.6,
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              <span
                className="shrink-0 text-[10px] tabular-nums w-7 text-right"
                style={{ color: 'var(--text-tertiary)' }}
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
      <div className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Latency
      </div>
      <div className="flex items-end gap-0.5" style={{ height: 40 }}>
        {buckets.map((b) => {
          const heightPct = (b.count / maxCount) * 100;
          const label = formatLatencyBucket(b.bucket_ms);
          return (
            <div
              key={b.bucket_ms}
              className="flex flex-col items-center flex-1"
              title={`${label}: ${b.count}`}
            >
              <div className="w-full flex items-end" style={{ height: 32 }}>
                <div
                  className="w-full rounded-t-sm"
                  style={{
                    height: `${heightPct}%`,
                    minHeight: b.count > 0 ? 2 : 0,
                    background: 'var(--accent, #007aff)',
                    opacity: 0.7,
                    transition: 'height 0.3s ease',
                  }}
                />
              </div>
              <span
                className="text-[8px] tabular-nums mt-0.5 truncate w-full text-center"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {label}
              </span>
            </div>
          );
        })}
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
      <div className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Error Groups
      </div>
      <div className="flex flex-col gap-0.5">
        {groups.map((g) => {
          const isExpanded = expandedTool === g.tool;
          const isActive = errorsOnly && toolFilter.has(g.tool);
          return (
            <div key={g.tool}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExpandedTool(isExpanded ? null : g.tool)}
                  className="text-[9px] shrink-0"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: '0 2px' }}
                >
                  {isExpanded ? '▼' : '▶'}
                </button>
                <button
                  type="button"
                  onClick={() => onGroupClick(g.tool)}
                  className="flex-1 text-left text-[10px] truncate"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: isActive ? 'var(--red, #ef4444)' : 'var(--text-primary)',
                    fontWeight: isActive ? 600 : 400,
                    fontFamily: 'SF Mono, Menlo, monospace',
                    padding: 0,
                  }}
                >
                  {g.tool}
                </button>
                <span
                  className="shrink-0 text-[9px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full"
                  style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--red, #ef4444)' }}
                >
                  {g.count}
                </span>
              </div>
              {isExpanded && (
                <div
                  className="mt-0.5 ml-5 text-[9px] truncate rounded px-1.5 py-1"
                  style={{
                    background: 'rgba(239,68,68,0.06)',
                    color: 'var(--text-secondary)',
                    fontFamily: 'SF Mono, Menlo, monospace',
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
      <div className="text-[10px] font-semibold mb-1.5 flex items-center gap-1" style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        <span>Last {windowLabel(windowMs)}</span>
        {activeRange !== null && (
          <button
            type="button"
            onClick={() => onSelectRange(null)}
            title="Clear time-range filter"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--accent, #007aff)',
              fontSize: 9,
              lineHeight: 1,
              textTransform: 'none',
            }}
          >
            clear ✕
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
                background: hasErrors
                  ? 'var(--red, #ef4444)'
                  : 'var(--accent, #007aff)',
                opacity: activeRange !== null ? (inRange ? 0.9 : 0.3) : 0.65,
                transition: 'height 0.3s ease, opacity 0.15s ease',
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
              background: 'var(--accent, #007aff)',
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
      className="shrink-0 px-3 py-2.5 flex flex-col gap-3"
      style={{
        borderBottom: '0.5px solid var(--border-row)',
        background: 'var(--bg-grouped)',
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
            <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
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
      style={{
        background: 'var(--bg-inset)',
        border: 'none',
        borderBottom: '0.5px solid var(--border-row)',
        cursor: 'pointer',
        height: 24,
        fontSize: 11,
        color: 'var(--text-secondary)',
        fontFamily: 'SF Mono, Menlo, monospace',
      }}
    >
      <span style={{ width: 10, color: 'var(--text-tertiary)' }}>
        {collapsed ? '▶' : '▼'}
      </span>
      <span style={{ color: 'var(--text-primary)' }}>{shortId}</span>
      <span style={{ color: 'var(--text-tertiary)' }}>
        {group.entries.length} call{group.entries.length === 1 ? '' : 's'}
      </span>
      <span style={{ color: 'var(--text-tertiary)' }}>
        from {fromTime} to {toTime}
      </span>
      {group.error_count > 0 && (
        <span
          className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
          style={{
            background: 'rgba(239,68,68,0.15)',
            color: 'var(--red, #ef4444)',
            fontFamily: 'inherit',
          }}
        >
          {group.error_count} error{group.error_count === 1 ? '' : 's'}
        </span>
      )}
    </button>
  );
}

// ── Keyboard help overlay ─────────────────────────────────────────────────

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: '/', desc: 'Focus search' },
  { keys: 'j', desc: 'Next entry' },
  { keys: 'k', desc: 'Previous entry' },
  { keys: 'Enter', desc: 'Expand / collapse selected' },
  { keys: 'Esc', desc: 'Blur search · clear search · clear filters · deselect' },
  { keys: '?', desc: 'Toggle this help' },
];

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const chipStyle: CSSProperties = {
    display: 'inline-block',
    minWidth: 18,
    textAlign: 'center',
    padding: '1px 6px',
    borderRadius: 5,
    background: 'var(--bg-inset)',
    border: '0.5px solid var(--border-row)',
    fontFamily: 'SF Mono, Menlo, monospace',
    fontSize: 11,
    color: 'var(--text-primary)',
  };
  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
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
          background: 'var(--bg-grouped)',
          border: '0.5px solid var(--border-row)',
          borderRadius: 12,
          padding: '14px 18px',
          minWidth: 320,
          maxWidth: 420,
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        }}
      >
        <div
          className="text-[11px] font-semibold mb-2.5"
          style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          Keyboard Shortcuts
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '6px 12px',
            alignItems: 'center',
            fontSize: 12,
            color: 'var(--text-secondary)',
          }}
        >
          {SHORTCUTS.map((s) => (
            <div key={s.keys} style={{ display: 'contents' }}>
              <span style={chipStyle}>{s.keys}</span>
              <span>{s.desc}</span>
            </div>
          ))}
        </div>
        <div className="text-[10px] mt-3" style={{ color: 'var(--text-tertiary)' }}>
          Press Esc or ? to close.
        </div>
      </div>
    </div>
  );
}

export function ToolActivity({
  root,
  onOpenFileInGraph,
}: {
  root: string;
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
      if (res.ok) {
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
    } catch {
      /* history is optional — live SSE is the primary source */
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
        case 'j':
          e.preventDefault();
          setSelectedIdx((i) =>
            filtered.length === 0 ? -1 : Math.min(i + 1, filtered.length - 1),
          );
          break;
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
      className="flex flex-col h-full"
      style={{ color: 'var(--text-primary)', position: 'relative' }}
    >
      {/* ── Header ── */}
      <div
        className="shrink-0 px-3 pt-3 pb-2"
        style={{ borderBottom: '0.5px solid var(--border-row)' }}
      >
        <div className="flex items-center justify-end gap-1.5 mb-2">
          {paused ? (
            <span
              className="text-[10px] flex items-center gap-1"
              style={{ color: 'var(--warning, #f97316)' }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: 'var(--warning, #f97316)' }}
              />
              Paused ({pausedBufferRef.current.length})
            </span>
          ) : connected ? (
            <span
              className="text-[10px] flex items-center gap-1"
              style={{ color: 'var(--success, #22c55e)' }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: 'var(--success, #22c55e)' }}
              />
              Live
            </span>
          ) : (
            <span
              className="text-[10px] flex items-center gap-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: 'var(--text-tertiary)' }}
              />
              Offline
            </span>
          )}
          <span
            className="text-[10px] tabular-nums"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {entries.length.toLocaleString()} calls
          </span>
          {/* Pause / Clear / Export — local buffer controls */}
          <div className="flex items-center gap-0.5 ml-1">
            <button
              type="button"
              onClick={handleTogglePause}
              title={paused ? 'Resume live feed' : 'Pause live feed'}
              aria-label={paused ? 'Resume live feed' : 'Pause live feed'}
              style={{
                width: 22,
                height: 22,
                borderRadius: 999,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                lineHeight: 1,
                padding: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-tertiary)';
              }}
            >
              {paused ? '▶' : '⏸'}
            </button>
            <button
              type="button"
              onClick={handleClear}
              title="Clear local buffer"
              aria-label="Clear local buffer"
              style={{
                width: 22,
                height: 22,
                borderRadius: 999,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                lineHeight: 1,
                padding: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-tertiary)';
              }}
            >
              ⌫
            </button>
            <button
              type="button"
              onClick={handleExport}
              title="Export filtered entries as JSONL"
              aria-label="Export filtered entries as JSONL"
              style={{
                width: 22,
                height: 22,
                borderRadius: 999,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                lineHeight: 1,
                padding: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-tertiary)';
              }}
            >
              ⤓
            </button>
          </div>
        </div>

        {/* Search input — case-insensitive substring match across params + tool.
            Group-by-session toggle lives on the same row, at the left edge. */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <button
            type="button"
            onClick={() => setGroupBySession((v) => !v)}
            title="Group entries by session_id"
            aria-pressed={groupBySession}
            className="text-[11px] px-2.5 py-1 rounded-full transition-all shrink-0"
            style={{
              background: groupBySession ? 'var(--accent)' : 'var(--bg-inset)',
              color: groupBySession ? '#fff' : 'var(--text-secondary)',
              fontWeight: groupBySession ? 600 : 400,
              cursor: 'pointer',
              border: 'none',
            }}
          >
            Group by session
          </button>
          <div style={{ position: 'relative', width: 180 }}>
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search params, tool…"
              aria-label="Search calls"
              style={{
                width: '100%',
                fontSize: 11,
                padding: query ? '4px 22px 4px 8px' : '4px 8px',
                background: 'var(--fill-control, var(--bg-inset))',
                color: 'var(--text-primary)',
                border: '0.5px solid var(--border-row)',
                borderRadius: 6,
                outline: 'none',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
            {query !== '' && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                title="Clear search"
                style={{
                  position: 'absolute',
                  right: 4,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  padding: '0 4px',
                  cursor: 'pointer',
                  color: 'var(--text-tertiary)',
                  fontSize: 12,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Filter chips — All clears the tool set, Errors toggles independently,
            tool chips toggle membership in the multi-select set. */}
        <div className="flex gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
          <FilterChip
            label="All"
            active={toolFilter.size === 0}
            onClick={() => {
              if (toolFilter.size > 0) setToolFilter(new Set());
            }}
          />
          <FilterChip
            label="Errors"
            active={errorsOnly}
            onClick={() => setErrorsOnly((v) => !v)}
          />
          {top5.map((tool) => (
            <FilterChip
              key={tool}
              label={tool}
              active={toolFilter.has(tool)}
              onClick={() => {
                setToolFilter((prev) => {
                  const next = new Set(prev);
                  if (next.has(tool)) next.delete(tool);
                  else next.add(tool);
                  return next;
                });
              }}
            />
          ))}
          {/* Time-range filter chip — present only while a sparkline range is
              active. Styled like a filter chip but with an accent border to
              mark it as a special (client-side) filter. ✕ clears the range. */}
          {timeRange !== null && (
            <button
              type="button"
              onClick={() => setTimeRange(null)}
              title="Clear time range filter"
              className="text-[11px] px-2.5 py-1 rounded-full transition-all shrink-0 flex items-center gap-1 tabular-nums"
              style={{
                background: 'var(--accent-soft, rgba(0,122,255,0.12))',
                color: 'var(--accent, #007aff)',
                border: '0.5px solid var(--accent, #007aff)',
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              🕒 {new Date(timeRange.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              –
              {new Date(timeRange.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              <span style={{ marginLeft: 2 }}>✕</span>
            </button>
          )}
        </div>
      </div>

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
          className="shrink-0 px-3 py-1.5 text-[11px]"
          style={{
            background: 'rgba(239,68,68,0.08)',
            color: 'var(--red, #ef4444)',
            borderBottom: '0.5px solid var(--border-row)',
          }}
        >
          {error}
        </div>
      )}

      {/* ── Entry list ── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
        style={{ background: 'var(--bg-grouped)', borderRadius: '0 0 10px 10px' }}
      >
        {filtered.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full text-center px-6 py-12"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <div className="text-[13px] mb-1">
              {toolFilter.size === 0 && !errorsOnly && query === '' && timeRange === null
                ? 'No tool calls yet'
                : 'No matching entries'}
            </div>
            <div className="text-[11px]">
              {toolFilter.size === 0 && !errorsOnly && query === '' && timeRange === null
                ? 'Run a tool from Claude Code to see activity here.'
                : 'Try a different filter or clear the search.'}
            </div>
          </div>
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
