/**
 * ProjectStatsModal — full-screen modal that renders the rich per-project
 * stats payload returned by GET /api/projects/full-stats?project=<root>.
 *
 * Modeled on memoir's `/stats` (7 tabs). Anatomy mirrors the existing
 * Activity tab:
 *   - Top tab bar with the 7 sections
 *   - Each tab renders the corresponding JSON section as a panel
 *   - Refresh + Export JSON in the header
 *   - Closes on Esc + backdrop click
 *
 * No new chart deps — bar charts are inline SVG.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate, formatNumber } from '../i18n/format';
import { Badge, type Tone } from '../lattice/ui';

const BASE = 'http://127.0.0.1:3741';

/** Link health reads as a tone *and* a glyph — colour alone is not a signal. */
const LINK_HEALTH: Record<string, { tone: Tone; icon: string }> = {
  ok: { tone: 'green', icon: 'check' },
  missing: { tone: 'red', icon: 'warning' },
};

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

const SECTIONS: Array<{ key: SectionKey; labelKey: string }> = [
  { key: 'index', labelKey: 'tabIndex' },
  { key: 'tools', labelKey: 'tabTools' },
  { key: 'decisions', labelKey: 'tabDecisions' },
  { key: 'performance', labelKey: 'tabPerformance' },
  { key: 'subprojects', labelKey: 'tabSubprojects' },
  { key: 'quality', labelKey: 'tabQuality' },
  { key: 'content', labelKey: 'tabContent' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return formatNumber(n);
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
  const { t } = useTranslation('stats');
  if (data.length === 0) {
    return (
      <div className="text-[11px]" style={{ color: 'var(--label-secondary)' }}>
        {t('noData')}
      </div>
    );
  }
  const localMax = Math.max(max ?? 0, ...data.map((d) => d.value), 1);
  return (
    <div className="flex flex-col gap-1">
      {data.map((d) => {
        const pct = (d.value / localMax) * 100;
        return (
          <div
            key={d.label}
            className="flex items-center gap-2"
            title={d.hint ?? formatNumber(d.value)}
          >
            <span
              className="shrink-0 text-[11px] tabular-nums w-32 truncate"
              style={{
                color: 'var(--label)',
                fontFamily: 'SF Mono, Menlo, monospace',
              }}
            >
              {d.label}
            </span>
            <div
              className="flex-1 relative h-3 rounded-sm overflow-hidden"
              style={{ background: 'var(--surface)' }}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-sm"
                style={{
                  width: `${pct}%`,
                  background: 'var(--accent)',
                  opacity: 0.7,
                }}
              />
            </div>
            <span
              className="shrink-0 text-[11px] tabular-nums w-12 text-right"
              style={{ color: 'var(--label-secondary)' }}
            >
              {formatNumber(d.value)}
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
        color: 'var(--label-secondary)',
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
      style={{ background: 'var(--surface)', minWidth: 110 }}
    >
      <div className="text-[10px]" style={{ color: 'var(--label-secondary)' }}>
        {label}
      </div>
      <div
        className="text-[15px] font-semibold tabular-nums mt-0.5"
        style={{ color: 'var(--label)' }}
      >
        {value}
      </div>
    </div>
  );
}

function NoData({ reason }: { reason?: string }) {
  const { t } = useTranslation('stats');
  return (
    <div
      className="text-[12px] text-center px-3 py-6"
      style={{ color: 'var(--label-secondary)' }}
    >
      {reason ?? t('noSectionData')}
    </div>
  );
}

/** Date + time, the way the active language writes them. */
function fmtDateTime(value: string): string {
  return formatDate(new Date(value), { dateStyle: 'medium', timeStyle: 'short' });
}

function IndexPanel({ data }: { data: IndexSection | null }) {
  const { t } = useTranslation('stats');
  if (!data) return <NoData reason={t('indexUnavailable')} />;
  const tierData: BarDatum[] = Object.entries(data.resolution_tiers).map(([tier, count]) => ({
    label: tier,
    value: count,
  }));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <StatTile label={t('files')} value={fmtNumber(data.files)} />
        <StatTile label={t('symbols')} value={fmtNumber(data.symbols)} />
        <StatTile label={t('edges')} value={fmtNumber(data.edges)} />
        <StatTile label={t('coverage')} value={fmtPct(data.dependency_coverage_pct)} />
        <StatTile
          label={t('lastIndexed')}
          value={data.last_indexed ? fmtDateTime(data.last_indexed) : '—'}
        />
      </div>
      <div>
        <SectionHeader>{t('edgeResolutionTiers')}</SectionHeader>
        <HBarChart data={tierData} />
      </div>
    </div>
  );
}

function ToolsPanel({ data }: { data: ToolsSection | null }) {
  const { t } = useTranslation('stats');
  if (!data) return <NoData reason={t('toolsUnavailable')} />;
  if (data.per_tool.length === 0) {
    return <NoData reason={t('noToolCalls')} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <StatTile
          label={t('window')}
          value={t('windowHours', { total: Math.round(data.window_ms / 3_600_000) })}
        />
        <StatTile label={t('totalCalls')} value={fmtNumber(data.total_calls)} />
      </div>
      <div>
        <SectionHeader>{t('perToolLatency')}</SectionHeader>
        <table
          className="w-full border-collapse text-[12px]"
          style={{ color: 'var(--label)' }}
        >
          <thead>
            <tr style={{ borderBottom: '0.5px solid var(--separator)' }}>
              <th
                className="text-left py-1.5 px-2 text-[10px] font-semibold"
                style={{
                  color: 'var(--label-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {t('colTool')}
              </th>
              <th
                className="text-right py-1.5 px-2 text-[10px] font-semibold"
                style={{
                  color: 'var(--label-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {t('colCount')}
              </th>
              <th
                className="text-right py-1.5 px-2 text-[10px] font-semibold"
                style={{
                  color: 'var(--label-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {t('colMedian')}
              </th>
              <th
                className="text-right py-1.5 px-2 text-[10px] font-semibold"
                style={{
                  color: 'var(--label-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {t('colP95')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.per_tool.map((t) => (
              <tr key={t.tool} style={{ borderBottom: '0.5px solid var(--separator)' }}>
                <td
                  className="py-1.5 px-2"
                  style={{
                    fontFamily: 'SF Mono, Menlo, monospace',
                    color: 'var(--label)',
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
  const { t } = useTranslation('stats');
  if (!data) return <NoData reason={t('decisionsUnavailable')} />;
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
        <StatTile label={t('total')} value={fmtNumber(data.total)} />
      </div>
      <div>
        <SectionHeader>{t('byType')}</SectionHeader>
        <HBarChart data={byTypeData} />
      </div>
      {histData && (
        <div>
          <SectionHeader>{t('confidenceHistogram')}</SectionHeader>
          <HBarChart data={histData} />
        </div>
      )}
      <div>
        <SectionHeader>{t('topLinked')}</SectionHeader>
        {data.top_linked.length === 0 ? (
          <NoData reason={t('noLinkedDecisions')} />
        ) : (
          <table
            className="w-full border-collapse text-[12px]"
            style={{ color: 'var(--label)' }}
          >
            <thead>
              <tr style={{ borderBottom: '0.5px solid var(--separator)' }}>
                <th
                  className="text-left py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--label-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {t('colTitle')}
                </th>
                <th
                  className="text-left py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--label-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {t('colType')}
                </th>
                <th
                  className="text-right py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--label-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {t('colRefs')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.top_linked.map((d) => (
                <tr key={d.id} style={{ borderBottom: '0.5px solid var(--separator)' }}>
                  <td className="py-1.5 px-2 truncate max-w-[400px]" title={d.title}>
                    {d.title}
                  </td>
                  <td className="py-1.5 px-2" style={{ color: 'var(--label-secondary)' }}>
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
  const { t } = useTranslation('stats');
  if (!data) return <NoData />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label={t('embeddingCacheHitRate')}
          value={data.embedding_cache_hit_rate !== null ? fmtPct(data.embedding_cache_hit_rate) : '—'}
        />
        <StatTile label={t('searchP50')} value={fmtMs(data.search_latency_p50_ms)} />
        <StatTile label={t('searchP95')} value={fmtMs(data.search_latency_p95_ms)} />
        <StatTile
          label={t('indexerThroughput')}
          value={
            data.indexer_throughput_files_per_sec !== null
              ? formatNumber(data.indexer_throughput_files_per_sec, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
              : '—'
          }
        />
      </div>
      {data.notes.length > 0 && (
        <div>
          <SectionHeader>{t('notes')}</SectionHeader>
          <ul className="text-[11px] space-y-0.5 list-disc list-inside" style={{ color: 'var(--label-secondary)' }}>
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
  const { t } = useTranslation('stats');
  if (!data) return <NoData reason={t('subprojectsUnavailable')} />;
  if (data.count === 0) return <NoData reason={t('noSubprojects')} />;
  return (
    <div className="flex flex-col gap-3">
      <StatTile label={t('count')} value={fmtNumber(data.count)} />
      <table className="w-full border-collapse text-[12px]" style={{ color: 'var(--label)' }}>
        <thead>
          <tr style={{ borderBottom: '0.5px solid var(--separator)' }}>
            <th
              className="text-left py-1.5 px-2 text-[10px] font-semibold"
              style={{
                color: 'var(--label-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {t('colName')}
            </th>
            <th
              className="text-left py-1.5 px-2 text-[10px] font-semibold"
              style={{
                color: 'var(--label-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {t('colRepoRoot')}
            </th>
            <th
              className="text-right py-1.5 px-2 text-[10px] font-semibold"
              style={{
                color: 'var(--label-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {t('colServices')}
            </th>
            <th
              className="text-right py-1.5 px-2 text-[10px] font-semibold"
              style={{
                color: 'var(--label-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {t('colEndpoints')}
            </th>
            <th
              className="text-left py-1.5 px-2 text-[10px] font-semibold"
              style={{
                color: 'var(--label-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {t('colLink')}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((s) => (
            <tr key={s.name} style={{ borderBottom: '0.5px solid var(--separator)' }}>
              <td className="py-1.5 px-2">{s.name}</td>
              <td
                className="py-1.5 px-2 truncate max-w-[300px]"
                style={{
                  fontFamily: 'SF Mono, Menlo, monospace',
                  color: 'var(--label-secondary)',
                }}
                title={s.repoRoot}
              >
                {s.repoRoot}
              </td>
              <td className="text-right py-1.5 px-2 tabular-nums">{fmtNumber(s.serviceCount)}</td>
              <td className="text-right py-1.5 px-2 tabular-nums">{fmtNumber(s.endpointCount)}</td>
              <td className="py-1.5 px-2">
                <Badge
                  tone={LINK_HEALTH[s.link_health]?.tone ?? 'neutral'}
                  icon={LINK_HEALTH[s.link_health]?.icon ?? 'link'}
                >
                  {s.link_health}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QualityPanel({ data }: { data: QualitySection | null }) {
  const { t } = useTranslation('stats');
  if (!data) return <NoData />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <StatTile label={t('deadExports')} value={fmtNumber(data.dead_exports)} />
        <StatTile label={t('untestedSymbols')} value={fmtNumber(data.untested_symbols)} />
      </div>
      <div>
        <SectionHeader>{t('complexityHotspots')}</SectionHeader>
        {data.complexity_hotspots.length === 0 ? (
          <NoData reason={t('noComplexityData')} />
        ) : (
          <table
            className="w-full border-collapse text-[12px]"
            style={{ color: 'var(--label)' }}
          >
            <thead>
              <tr style={{ borderBottom: '0.5px solid var(--separator)' }}>
                <th
                  className="text-left py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--label-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {t('colSymbol')}
                </th>
                <th
                  className="text-left py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--label-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {t('colLocation')}
                </th>
                <th
                  className="text-right py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--label-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {t('colCyclomatic')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.complexity_hotspots.map((h) => (
                <tr
                  key={`${h.file}:${h.line}:${h.name}`}
                  style={{ borderBottom: '0.5px solid var(--separator)' }}
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
                      color: 'var(--label-secondary)',
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
                          ? 'var(--status-red)'
                          : h.cyclomatic >= 10
                            ? 'var(--status-orange)'
                            : 'var(--label)',
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
  const { t } = useTranslation('stats');
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
        <SectionHeader>{t('languageDistribution')}</SectionHeader>
        <HBarChart data={langData} />
      </div>
      <div>
        <SectionHeader>{t('frameworkDistribution')}</SectionHeader>
        <HBarChart data={fwData} />
      </div>
      <div>
        <SectionHeader>{t('largestFiles')}</SectionHeader>
        {data.largest_files.length === 0 ? (
          <NoData />
        ) : (
          <table
            className="w-full border-collapse text-[12px]"
            style={{ color: 'var(--label)' }}
          >
            <thead>
              <tr style={{ borderBottom: '0.5px solid var(--separator)' }}>
                <th
                  className="text-left py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--label-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {t('colPath')}
                </th>
                <th
                  className="text-right py-1.5 px-2 text-[10px] font-semibold"
                  style={{
                    color: 'var(--label-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {t('colSymbols')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.largest_files.map((f) => (
                <tr key={f.path} style={{ borderBottom: '0.5px solid var(--separator)' }}>
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
  const { t } = useTranslation('stats');
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
      setError((err as Error)?.message ?? t('loadFailed'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [root, t]);

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
          background: 'var(--surface-sunken)',
          borderRadius: 12,
          boxShadow: '0 25px 60px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t('windowTitle', { project: projectName })}
      >
        {/* Header */}
        <div
          className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5"
          style={{
            borderBottom: '0.5px solid var(--separator)',
            background: 'var(--fill-quaternary)',
          }}
        >
          <div className="min-w-0">
            <div
              className="text-[13px] font-semibold truncate"
              style={{ color: 'var(--label)' }}
            >
              {t('heading', { project: projectName })}
            </div>
            <div
              className="text-[10px] truncate"
              style={{
                color: 'var(--label-secondary)',
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
                background: 'var(--fill-quaternary)',
                color: 'var(--accent)',
                border: '0.5px solid var(--separator)',
              }}
            >
              {refreshing ? t('refreshing') : t('refresh')}
            </button>
            <button
              type="button"
              disabled={!payload}
              onClick={handleExport}
              className="text-[11px] px-2 py-1 rounded font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{
                background: 'var(--fill-quaternary)',
                color: 'var(--accent)',
                border: '0.5px solid var(--separator)',
              }}
            >
              {t('exportJson')}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('close')}
              className="w-6 h-6 rounded-full flex items-center justify-center transition-colors"
              style={{ color: 'var(--label-secondary)' }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--fill-quaternary)';
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
            borderBottom: '0.5px solid var(--separator)',
            background: 'var(--surface-sunken)',
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
                  color: active ? 'var(--on-accent)' : 'var(--label-secondary)',
                  fontWeight: active ? 600 : 400,
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {t(s.labelKey)}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div
              className="flex items-center justify-center h-full text-[12px]"
              style={{ color: 'var(--label-secondary)' }}
            >
              {t('loading')}
            </div>
          ) : error ? (
            <div
              className="flex flex-col items-center justify-center h-full gap-2 text-[12px]"
              style={{ color: 'var(--status-red)' }}
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
                  background: 'var(--fill-quaternary)',
                  color: 'var(--accent)',
                  border: '0.5px solid var(--separator)',
                }}
              >
                {t('retry')}
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
              color: 'var(--label-secondary)',
              borderTop: '0.5px solid var(--separator)',
              background: 'var(--fill-quaternary)',
            }}
          >
            {t('footer', { generated: fmtDateTime(payload.generated_at) })}
          </div>
        )}
      </div>
    </div>
  );
}
