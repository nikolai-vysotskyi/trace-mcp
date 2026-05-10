/**
 * ProjectStatsModal — full-screen modal that renders the rich per-project
 * stats payload returned by GET /api/projects/full-stats?project=<root>.
 *
 * Modeled on memoir's `/stats` (7 tabs). Anatomy mirrors the existing
 * Activity/Dashboard tabs:
 *   - Top tab bar with the 7 sections
 *   - Each tab renders the corresponding JSON section as a panel
 *   - Refresh + Export JSON in the header
 *   - Closes on Esc + backdrop click
 *
 * No new chart deps — bar charts are inline SVG.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

const BASE = 'http://127.0.0.1:3741';

// ── Payload shape (must mirror src/api/project-stats-routes.ts) ───────────

interface IndexSection {
  files: number;
  symbols: number;
  edges: number;
  resolution_tiers: Record<string, number>;
  last_indexed: string | null;
  dependency_coverage_pct: number | null;
}

interface ToolStat {
  tool: string;
  count: number;
  median_ms: number;
  p95_ms: number;
}

interface ToolsSection {
  window_ms: number;
  total_calls: number;
  per_tool: ToolStat[];
}

interface DecisionsSection {
  total: number;
  by_type: Record<string, number>;
  confidence_histogram: Record<string, number> | null;
  top_linked: Array<{ id: number; title: string; type: string; references: number }>;
}

interface PerformanceSection {
  embedding_cache_hit_rate: number | null;
  search_latency_p50_ms: number | null;
  search_latency_p95_ms: number | null;
  indexer_throughput_files_per_sec: number | null;
  notes: string[];
}

interface SubprojectInfo {
  name: string;
  repoRoot: string;
  serviceCount: number;
  endpointCount: number;
  link_health: 'ok' | 'missing' | 'unknown';
}

interface SubprojectsSection {
  count: number;
  items: SubprojectInfo[];
}

interface QualitySection {
  dead_exports: number | null;
  untested_symbols: number | null;
  complexity_hotspots: Array<{
    name: string;
    file: string;
    line: number;
    cyclomatic: number;
  }>;
}

interface ContentSection {
  languages: Array<{ language: string; files: number }>;
  largest_files: Array<{ path: string; symbols: number }>;
  frameworks: Array<{ framework: string; files: number }>;
}

export interface ProjectStatsPayload {
  project: string;
  generated_at: string;
  index: IndexSection | null;
  tools: ToolsSection | null;
  decisions: DecisionsSection | null;
  performance: PerformanceSection | null;
  subprojects: SubprojectsSection | null;
  quality: QualitySection | null;
  content: ContentSection | null;
}

type SectionKey =
  | 'index'
  | 'tools'
  | 'decisions'
  | 'performance'
  | 'subprojects'
  | 'quality'
  | 'content';

const SECTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: 'index', label: 'Index' },
  { key: 'tools', label: 'Tools' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'performance', label: 'Performance' },
  { key: 'subprojects', label: 'Subprojects' },
  { key: 'quality', label: 'Quality' },
  { key: 'content', label: 'Content' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString();
}

function fmtMs(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${n.toFixed(1)}%`;
}

function downloadJson(payload: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Inline SVG bar chart ───────────────────────────────────────────────────

interface BarDatum {
  label: string;
  value: number;
  hint?: string;
}

function HBarChart({ data, max }: { data: BarDatum[]; max?: number }) {
  if (data.length === 0) {
    return (
      <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        No data
      </div>
    );
  }
  const localMax = Math.max(max ?? 0, ...data.map((d) => d.value), 1);
  return (
    <div className="flex flex-col gap-1">
      {data.map((d) => {
        const pct = (d.value / localMax) * 100;
        return (
          <div key={d.label} className="flex items-center gap-2" title={d.hint ?? `${d.value}`}>
            <span
              className="shrink-0 text-[11px] tabular-nums w-32 truncate"
              style={{
                color: 'var(--text-primary)',
                fontFamily: 'SF Mono, Menlo, monospace',
              }}
            >
              {d.label}
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
                  opacity: 0.7,
                }}
              />
            </div>
            <span
              className="shrink-0 text-[11px] tabular-nums w-12 text-right"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {d.value.toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Section renderers ──────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[10px] font-semibold mb-2"
      style={{
        color: 'var(--text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}
    >
      {children}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="px-3 py-2 rounded-md"
      style={{ background: 'var(--bg-grouped)', minWidth: 110 }}
    >
      <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div
        className="text-[15px] font-semibold tabular-nums mt-0.5"
        style={{ color: 'var(--text-primary)' }}
      >
        {value}
      </div>
    </div>
  );
}

function NoData({ reason }: { reason?: string }) {
  return (
    <div
      className="text-[12px] text-center px-3 py-6"
      style={{ color: 'var(--text-tertiary)' }}
    >
      {reason ?? 'No data available for this section.'}
    </div>
  );
}

function IndexPanel({ data }: { data: IndexSection | null }) {
  if (!data) return <NoData reason="Index data unavailable (project not indexed)." />;
  const tierData: BarDatum[] = Object.entries(data.resolution_tiers).map(([tier, count]) => ({
    label: tier,
    value: count,
  }));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <StatTile label="Files" value={fmtNumber(data.files)} />
        <StatTile label="Symbols" value={fmtNumber(data.symbols)} />
        <StatTile label="Edges" value={fmtNumber(data.edges)} />
        <StatTile label="Coverage" value={fmtPct(data.dependency_coverage_pct)} />
        <StatTile
          label="Last Indexed"
          value={data.last_indexed ? new Date(data.last_indexed).toLocaleString() : '—'}
        />
      </div>
      <div>
        <SectionHeader>Edge resolution tiers</SectionHeader>
        <HBarChart data={tierData} />
      </div>
    </div>
  );
}

function ToolsPanel({ data }: { data: ToolsSection | null }) {
  if (!data) return <NoData reason="Tool stats unavailable." />;
  if (data.per_tool.length === 0) {
    return <NoData reason="No tool calls recorded in the last 24h." />;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <StatTile label="Window" value={`${Math.round(data.window_ms / 3_600_000)}h`} />
        <StatTile label="Total calls" value={fmtNumber(data.total_calls)} />
      </div>
      <div>
        <SectionHeader>Per-tool latency (last 24h)</SectionHeader>
        <table
          className="w-full border-collapse text-[12px]"
          style={{ color: 'var(--text-primary)' }}
        >
          <thead>
            <tr style={{ borderBottom: '0.5px solid var(--border-row)' }}>
              <th
                className="text-left py-1.5 px-2 text-[10px] font-semibold"
                style={{
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Tool
              </th>
              <th
                className="text-right py-1.5 px-2 text-[10px] font-semibold"
                style={{
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Count
              </th>
              <th
                className="text-right py-1.5 px-2 text-[10px] font-semibold"
                style={{
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Median
              </th>
              <th
                className="text-right py-1.5 px-2 text-[10px] font-semibold"
                style={{
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                p95
              </th>
            </tr>
          </thead>
          <tbody>
            {data.per_tool.map((t) => (
              <tr key={t.tool} style={{ borderBottom: '0.5px solid var(--border-row)' }}>
                <td
                  className="py-1.5 px-2"
                  style={{
                    fontFamily: 'SF Mono, Menlo, monospace',
                    color: 'var(--text-primary)',
                  }}
                >
                  {t.tool}
                </td>
                <td className="text-right py-1.5 px-2 tabular-nums">{fmtNumber(t.count)}</td>
                <td className="text-right py-1.5 px-2 tabular-nums">{fmtMs(t.median_ms)}</td>
                <td className="text-right py-1.5 px-2 tabular-nums">{fmtMs(t.p95_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DecisionsPanel({ data }: { data: DecisionsSection | null }) {
  if (!data) return <NoData reason="Decisions unavailable (decisions.db not initialised)." />;
  const byTypeData: BarDatum[] = Object.entries(data.by_type).map(([type, count]) => ({
    label: type,
    value: count,
  }));
  const histData: BarDatum[] | null = data.confidence_histogram
    ? Object.entries(data.confidence_histogram).map(([bucket, count]) => ({
        label: bucket,
        value: count,
      }))
    : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <StatTile label="Total" value={fmtNumber(data.total)} />
      </div>
      <div>
        <SectionHeader>By type</SectionHeader>
        <HBarChart data={byTypeData} />
      </div>
      {histData && (
        <div>
          <SectionHeader>Confidence histogram</SectionHeader>
          <HBarChart data={histData} />
        </div>
      )}
      <div>
        <SectionHeader>Top 5 most-linked decisions</SectionHeader>
        {data.top_linked.length === 0 ? (
          <NoData reason="No linked decisions yet." />
        ) : (
          <table
            className="w-full border-collapse text-[12px]"
            style={{ color: 'var(--text-primary)' }}
          >
            <thead>
              <tr style={{ borderBottom: '0.5px solid var(--border-row)' }}>
                <th
                  className="text-left py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Title
                </th>
                <th
                  className="text-left py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Type
                </th>
                <th
                  className="text-right py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Refs
                </th>
              </tr>
            </thead>
            <tbody>
              {data.top_linked.map((d) => (
                <tr key={d.id} style={{ borderBottom: '0.5px solid var(--border-row)' }}>
                  <td className="py-1.5 px-2 truncate max-w-[400px]" title={d.title}>
                    {d.title}
                  </td>
                  <td className="py-1.5 px-2" style={{ color: 'var(--text-secondary)' }}>
                    {d.type}
                  </td>
                  <td className="text-right py-1.5 px-2 tabular-nums">
                    {fmtNumber(d.references)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PerformancePanel({ data }: { data: PerformanceSection | null }) {
  if (!data) return <NoData />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label="Embedding cache hit rate"
          value={data.embedding_cache_hit_rate !== null ? fmtPct(data.embedding_cache_hit_rate) : '—'}
        />
        <StatTile label="Search p50" value={fmtMs(data.search_latency_p50_ms)} />
        <StatTile label="Search p95" value={fmtMs(data.search_latency_p95_ms)} />
        <StatTile
          label="Indexer (files/s)"
          value={
            data.indexer_throughput_files_per_sec !== null
              ? data.indexer_throughput_files_per_sec.toFixed(2)
              : '—'
          }
        />
      </div>
      {data.notes.length > 0 && (
        <div>
          <SectionHeader>Notes</SectionHeader>
          <ul className="text-[11px] space-y-0.5 list-disc list-inside" style={{ color: 'var(--text-secondary)' }}>
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SubprojectsPanel({ data }: { data: SubprojectsSection | null }) {
  if (!data) return <NoData reason="Subprojects unavailable (topology.db not initialised)." />;
  if (data.count === 0) return <NoData reason="No subprojects registered." />;
  return (
    <div className="flex flex-col gap-3">
      <StatTile label="Count" value={fmtNumber(data.count)} />
      <table className="w-full border-collapse text-[12px]" style={{ color: 'var(--text-primary)' }}>
        <thead>
          <tr style={{ borderBottom: '0.5px solid var(--border-row)' }}>
            <th
              className="text-left py-1.5 px-2 text-[10px] font-semibold"
              style={{
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Name
            </th>
            <th
              className="text-left py-1.5 px-2 text-[10px] font-semibold"
              style={{
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Repo Root
            </th>
            <th
              className="text-right py-1.5 px-2 text-[10px] font-semibold"
              style={{
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Services
            </th>
            <th
              className="text-right py-1.5 px-2 text-[10px] font-semibold"
              style={{
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Endpoints
            </th>
            <th
              className="text-left py-1.5 px-2 text-[10px] font-semibold"
              style={{
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Link
            </th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((s) => (
            <tr key={s.name} style={{ borderBottom: '0.5px solid var(--border-row)' }}>
              <td className="py-1.5 px-2">{s.name}</td>
              <td
                className="py-1.5 px-2 truncate max-w-[300px]"
                style={{
                  fontFamily: 'SF Mono, Menlo, monospace',
                  color: 'var(--text-secondary)',
                }}
                title={s.repoRoot}
              >
                {s.repoRoot}
              </td>
              <td className="text-right py-1.5 px-2 tabular-nums">{fmtNumber(s.serviceCount)}</td>
              <td className="text-right py-1.5 px-2 tabular-nums">{fmtNumber(s.endpointCount)}</td>
              <td className="py-1.5 px-2">
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase"
                  style={{
                    background:
                      s.link_health === 'ok'
                        ? 'rgba(34,197,94,0.15)'
                        : s.link_health === 'missing'
                          ? 'rgba(239,68,68,0.15)'
                          : 'rgba(107,114,128,0.15)',
                    color:
                      s.link_health === 'ok'
                        ? 'var(--success, #22c55e)'
                        : s.link_health === 'missing'
                          ? 'var(--red, #ef4444)'
                          : 'var(--text-tertiary)',
                  }}
                >
                  {s.link_health}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QualityPanel({ data }: { data: QualitySection | null }) {
  if (!data) return <NoData />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <StatTile label="Dead exports" value={fmtNumber(data.dead_exports)} />
        <StatTile label="Untested symbols" value={fmtNumber(data.untested_symbols)} />
      </div>
      <div>
        <SectionHeader>Top 10 complexity hotspots</SectionHeader>
        {data.complexity_hotspots.length === 0 ? (
          <NoData reason="No complexity data recorded." />
        ) : (
          <table
            className="w-full border-collapse text-[12px]"
            style={{ color: 'var(--text-primary)' }}
          >
            <thead>
              <tr style={{ borderBottom: '0.5px solid var(--border-row)' }}>
                <th
                  className="text-left py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Symbol
                </th>
                <th
                  className="text-left py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Location
                </th>
                <th
                  className="text-right py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Cyclomatic
                </th>
              </tr>
            </thead>
            <tbody>
              {data.complexity_hotspots.map((h) => (
                <tr
                  key={`${h.file}:${h.line}:${h.name}`}
                  style={{ borderBottom: '0.5px solid var(--border-row)' }}
                >
                  <td
                    className="py-1.5 px-2"
                    style={{ fontFamily: 'SF Mono, Menlo, monospace' }}
                  >
                    {h.name}
                  </td>
                  <td
                    className="py-1.5 px-2 truncate max-w-[300px]"
                    style={{
                      color: 'var(--text-secondary)',
                      fontFamily: 'SF Mono, Menlo, monospace',
                    }}
                    title={`${h.file}:${h.line}`}
                  >
                    {h.file}:{h.line}
                  </td>
                  <td
                    className="text-right py-1.5 px-2 tabular-nums font-semibold"
                    style={{
                      color:
                        h.cyclomatic >= 20
                          ? 'var(--red, #ef4444)'
                          : h.cyclomatic >= 10
                            ? 'var(--orange, #f97316)'
                            : 'var(--text-primary)',
                    }}
                  >
                    {h.cyclomatic}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ContentPanel({ data }: { data: ContentSection | null }) {
  if (!data) return <NoData />;
  const langData: BarDatum[] = data.languages.map((l) => ({
    label: l.language,
    value: l.files,
  }));
  const fwData: BarDatum[] = data.frameworks.map((f) => ({
    label: f.framework,
    value: f.files,
  }));
  return (
    <div className="flex flex-col gap-4">
      <div>
        <SectionHeader>Language distribution</SectionHeader>
        <HBarChart data={langData} />
      </div>
      <div>
        <SectionHeader>Framework distribution</SectionHeader>
        <HBarChart data={fwData} />
      </div>
      <div>
        <SectionHeader>Top 10 largest files (by symbol count)</SectionHeader>
        {data.largest_files.length === 0 ? (
          <NoData />
        ) : (
          <table
            className="w-full border-collapse text-[12px]"
            style={{ color: 'var(--text-primary)' }}
          >
            <thead>
              <tr style={{ borderBottom: '0.5px solid var(--border-row)' }}>
                <th
                  className="text-left py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Path
                </th>
                <th
                  className="text-right py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Symbols
                </th>
              </tr>
            </thead>
            <tbody>
              {data.largest_files.map((f) => (
                <tr key={f.path} style={{ borderBottom: '0.5px solid var(--border-row)' }}>
                  <td
                    className="py-1.5 px-2 truncate max-w-[480px]"
                    style={{ fontFamily: 'SF Mono, Menlo, monospace' }}
                    title={f.path}
                  >
                    {f.path}
                  </td>
                  <td className="text-right py-1.5 px-2 tabular-nums">{fmtNumber(f.symbols)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────

export interface ProjectStatsModalProps {
  root: string;
  onClose: () => void;
}

export function ProjectStatsModal({ root, onClose }: ProjectStatsModalProps) {
  const [payload, setPayload] = useState<ProjectStatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SectionKey>('index');

  const fetchPayload = useCallback(async () => {
    try {
      const res = await fetch(
        `${BASE}/api/projects/full-stats?project=${encodeURIComponent(root)}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as ProjectStatsPayload;
      setPayload(data);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to load stats');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [root]);

  useEffect(() => {
    void fetchPayload();
  }, [fetchPayload]);

  // Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchPayload();
  }, [fetchPayload]);

  const handleExport = useCallback(() => {
    if (!payload) return;
    const safeName = root.split(/[/\\]/).filter(Boolean).pop() ?? 'project';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJson(payload, `${safeName}-stats-${stamp}.json`);
  }, [payload, root]);

  const projectName = useMemo(
    () => root.split(/[/\\]/).filter(Boolean).pop() ?? root,
    [root],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className="flex flex-col"
        style={{
          width: 'min(960px, 96vw)',
          height: 'min(720px, 92vh)',
          background: 'var(--bg-primary)',
          borderRadius: 12,
          boxShadow: '0 25px 60px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={`Stats for ${projectName}`}
      >
        {/* Header */}
        <div
          className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5"
          style={{
            borderBottom: '0.5px solid var(--border-row)',
            background: 'var(--bg-secondary)',
          }}
        >
          <div className="min-w-0">
            <div
              className="text-[13px] font-semibold truncate"
              style={{ color: 'var(--text-primary)' }}
            >
              Stats — {projectName}
            </div>
            <div
              className="text-[10px] truncate"
              style={{
                color: 'var(--text-tertiary)',
                fontFamily: 'SF Mono, Menlo, monospace',
              }}
              title={root}
            >
              {root}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void handleRefresh()}
              className="text-[11px] px-2 py-1 rounded font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{
                background: 'var(--fill-control)',
                color: 'var(--accent)',
                border: '0.5px solid var(--border)',
              }}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              disabled={!payload}
              onClick={handleExport}
              className="text-[11px] px-2 py-1 rounded font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{
                background: 'var(--fill-control)',
                color: 'var(--accent)',
                border: '0.5px solid var(--border)',
              }}
            >
              Export JSON
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-6 h-6 rounded-full flex items-center justify-center transition-colors"
              style={{ color: 'var(--text-secondary)' }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--bg-inset)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              >
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div
          className="shrink-0 flex items-center gap-1 px-3 py-1.5 overflow-x-auto"
          style={{
            borderBottom: '0.5px solid var(--border-row)',
            background: 'var(--bg-primary)',
            scrollbarWidth: 'none',
          }}
        >
          {SECTIONS.map((s) => {
            const active = activeTab === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setActiveTab(s.key)}
                className="text-[11px] px-2.5 py-1 rounded transition-all shrink-0"
                style={{
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? '#fff' : 'var(--text-secondary)',
                  fontWeight: active ? 600 : 400,
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div
              className="flex items-center justify-center h-full text-[12px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Loading…
            </div>
          ) : error ? (
            <div
              className="flex flex-col items-center justify-center h-full gap-2 text-[12px]"
              style={{ color: 'var(--red, #ef4444)' }}
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  void fetchPayload();
                }}
                className="text-[11px] px-3 py-1 rounded font-medium"
                style={{
                  background: 'var(--fill-control)',
                  color: 'var(--accent)',
                  border: '0.5px solid var(--border)',
                }}
              >
                Retry
              </button>
            </div>
          ) : payload ? (
            <>
              {activeTab === 'index' && <IndexPanel data={payload.index} />}
              {activeTab === 'tools' && <ToolsPanel data={payload.tools} />}
              {activeTab === 'decisions' && <DecisionsPanel data={payload.decisions} />}
              {activeTab === 'performance' && <PerformancePanel data={payload.performance} />}
              {activeTab === 'subprojects' && <SubprojectsPanel data={payload.subprojects} />}
              {activeTab === 'quality' && <QualityPanel data={payload.quality} />}
              {activeTab === 'content' && <ContentPanel data={payload.content} />}
            </>
          ) : (
            <NoData />
          )}
        </div>

        {/* Footer */}
        {payload && (
          <div
            className="shrink-0 px-4 py-1.5 text-[10px]"
            style={{
              color: 'var(--text-tertiary)',
              borderTop: '0.5px solid var(--border-row)',
              background: 'var(--bg-secondary)',
            }}
          >
            Generated {new Date(payload.generated_at).toLocaleString()} · cached 30s · press Esc to close
          </div>
        )}
      </div>
    </div>
  );
}
