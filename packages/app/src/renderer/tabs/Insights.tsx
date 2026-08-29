/**
 * Insights tab.
 *
 * Surfaces three high-value reports for a project:
 *   - CLAUDE.md drift (stale paths / dead symbols in agent config)
 *   - Top PageRank-central files (architectural importance)
 *   - Risk hotspots (high complexity × high git churn)
 *
 * Shape (TRA-296): a single toolbar carrying the screen title, a segmented
 * report picker and ONE Run action, over one scrolling report pane. The old
 * list+detail split put a 280px column, a full-height divider and four
 * accent-filled Run buttons on screen for three items — a picker is the right
 * shape at that count, and it leaves exactly one primary action visible.
 *
 * The renderer/runtime split (this file vs insights-runtime.ts) follows the
 * pattern established by R08 (Notebook) so the project-root vitest config can
 * test pure logic without pulling in React under pnpm --frozen-lockfile.
 */
import { useCallback, useState } from 'react';
import { Badge, Button, EmptyState, SegmentedControl, Toolbar } from '../lattice/ui';
import {
  INSIGHT_REPORTS,
  REPORT_BY_ID,
  defaultInsightsClient,
  type InsightRows,
  type InsightsClient,
  type ReportId,
} from './insights-runtime';

// Re-export the pure runtime so existing imports stay stable.
export {
  INSIGHT_REPORTS,
  REPORT_BY_ID,
  defaultInsightsClient,
  buildRpcCall,
  flattenReport,
  flattenDriftRows,
  flattenPagerankRows,
  flattenRiskHotspotRows,
} from './insights-runtime';
export type { InsightsClient, ReportId, ReportDef, InsightRow, InsightRows } from './insights-runtime';

// ── Per-report state ─────────────────────────────────────────────────

type ReportStatus = 'idle' | 'running' | 'ok' | 'error';

interface ReportState {
  status: ReportStatus;
  rows: InsightRows | null;
  error?: string;
  lastRunAt?: number;
}

function initialReportStates(): Record<ReportId, ReportState> {
  const states = {} as Record<ReportId, ReportState>;
  for (const r of INSIGHT_REPORTS) {
    states[r.id] = { status: 'idle', rows: null };
  }
  return states;
}

/* Empty-state glyphs, one per report — a report pane with no data still needs
   geometry. Names come from lattice/icons.tsx. */
const REPORT_ICON: Record<ReportId, string> = {
  claudemd_drift: 'difference',
  pagerank: 'hub',
  risk_hotspots: 'bolt',
};

/* Severity badges carry a tone so "high" and "low" are not the same grey at a
   glance. The word stays in the badge — colour is never the only signal. */
const SEVERITY_TONE: Record<string, 'red' | 'orange' | 'neutral'> = {
  high: 'red',
  critical: 'red',
  medium: 'orange',
  moderate: 'orange',
};

/* What the report is DOING, in the user's terms — never the MCP tool id. The
   tool name is an internal identifier and has no business on screen. */
const RUNNING_COPY: Record<ReportId, string> = {
  claudemd_drift: 'Checking agent config against the index…',
  pagerank: 'Ranking files by import centrality…',
  risk_hotspots: 'Correlating complexity with git churn…',
};

// ── Component ────────────────────────────────────────────────────────

export function Insights({
  root,
  client = defaultInsightsClient,
}: {
  root: string;
  client?: InsightsClient;
}) {
  const [states, setStates] = useState<Record<ReportId, ReportState>>(() => initialReportStates());
  const [focused, setFocused] = useState<ReportId>(INSIGHT_REPORTS[0].id);

  const runReport = useCallback(
    async (id: ReportId) => {
      setStates((prev) => ({
        ...prev,
        [id]: { ...prev[id], status: 'running', error: undefined },
      }));
      try {
        const rows = await client.runReport(id, root);
        setStates((prev) => ({
          ...prev,
          [id]: { status: 'ok', rows, lastRunAt: Date.now() },
        }));
      } catch (err) {
        setStates((prev) => ({
          ...prev,
          [id]: { ...prev[id], status: 'error', error: (err as Error).message ?? 'Unknown error' },
        }));
      }
    },
    [client, root],
  );

  const focusedDef = REPORT_BY_ID[focused];
  const focusedState = states[focused];
  const running = focusedState.status === 'running';
  const runLabel = running ? 'Running…' : focusedState.status === 'ok' ? 'Refresh' : 'Run';

  return (
    <div
      className="flex flex-col h-full"
      style={{ WebkitAppRegion: 'no-drag', overflow: 'hidden' } as React.CSSProperties}
    >
      {/* Toolbar — title, report picker, the single primary action. */}
      <Toolbar className="gap-3">
        <h1 className="t-title-3" style={{ color: 'var(--label)', margin: 0, flexShrink: 0 }}>
          Insights
        </h1>
        <SegmentedControl
          aria-label="Report"
          value={focused}
          onChange={setFocused}
          options={INSIGHT_REPORTS.map((r) => ({
            value: r.id,
            label: r.title,
            title: r.description,
          }))}
        />
        <span style={{ flex: 1 }} />
        {/* One Run on screen at a time: while the report has never been run,
            the empty state below carries it — repeating it here would put two
            accent-filled buttons on one screen for one command. */}
        {focusedState.status !== 'idle' && (
          <Button
            variant="prominent"
            onClick={() => runReport(focused)}
            disabled={running}
            aria-label={`${runLabel} ${focusedDef.title}`}
          >
            {runLabel}
          </Button>
        )}
      </Toolbar>

      {/* Report pane — one scroll container. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ padding: 'var(--space-20) var(--space-16)' }}>
          {focusedState.status !== 'idle' && (
            <div style={{ marginBottom: 'var(--space-16)' }}>
              <div className="t-title-3" style={{ color: 'var(--label)' }}>
                {focusedDef.title}
              </div>
              <div className="t-body" style={{ color: 'var(--label-secondary)' }}>
                {focusedDef.description}
              </div>
            </div>
          )}

          {focusedState.status === 'idle' && (
            <EmptyState
              icon={REPORT_ICON[focused]}
              iconSize={32}
              title={focusedDef.title}
              subtitle={focusedDef.description}
              action={
                <Button variant="prominent" size="large" onClick={() => runReport(focused)}>
                  Run
                </Button>
              }
            />
          )}

          {focusedState.status === 'running' && <RowsSkeleton />}

          {focusedState.status === 'error' && (
            <div
              role="alert"
              className="t-body"
              style={{
                padding: 'var(--space-8) var(--space-12)',
                borderRadius: 'var(--radius-input)',
                color: 'var(--status-red)',
                background: 'color-mix(in oklab, var(--status-red) 10%, transparent)',
                boxShadow: 'inset 0 0 0 0.5px color-mix(in oklab, var(--status-red) 35%, transparent)',
              }}
            >
              {focusedState.error}
            </div>
          )}

          {focusedState.status === 'ok' && focusedState.rows && (
            <RowsView rows={focusedState.rows} icon={REPORT_ICON[focused]} />
          )}
        </div>
      </div>

      {/* Live region so the run's progress reaches a screen reader — the
          skeleton alone is silent. */}
      <span
        aria-live="polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {running ? RUNNING_COPY[focused] : ''}
      </span>
    </div>
  );
}

// ── Rows view ────────────────────────────────────────────────────────

function RowsView({ rows, icon }: { rows: InsightRows; icon: string }) {
  if (rows.rows.length === 0) {
    return (
      <EmptyState
        icon={icon}
        iconSize={32}
        title="Nothing to report"
        subtitle="This report came back empty — nothing in the project matches it right now."
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.rows.map((row, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are reconstructed wholesale on each refresh, index is stable within a render.
          key={i}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 'var(--space-12)',
            padding: 'var(--space-8) var(--space-12)',
            borderRadius: 'var(--radius-row)',
            /* A list, not a stack of cards: the hairline between rows IS the
               edge. No per-row fill, no per-row border, no shadow. */
            boxShadow: i === 0 ? undefined : 'inset 0 0.5px 0 var(--separator)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="t-body"
              style={{
                fontFamily: 'var(--font-mono)',
                color: 'var(--label)',
                wordBreak: 'break-all',
              }}
            >
              {row.primary}
            </div>
            {row.secondary && (
              <div className="t-caption" style={{ color: 'var(--label-secondary)' }}>
                {row.secondary}
              </div>
            )}
          </div>
          {row.badge && (
            <Badge tone={SEVERITY_TONE[row.badge.toLowerCase()] ?? 'neutral'}>{row.badge}</Badge>
          )}
        </div>
      ))}
    </div>
  );
}

/* Skeleton at the final geometry — a centred spinner would move the layout
   when the rows land. */
function RowsSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }} aria-hidden="true">
      <style>{`@keyframes insights-pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }`}</style>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-12)',
            padding: 'var(--space-8) var(--space-12)',
            boxShadow: i === 0 ? undefined : 'inset 0 0.5px 0 var(--separator)',
          }}
        >
          <div
            style={{
              flex: 1,
              height: 'var(--leading-body)',
              maxWidth: `${68 - (i % 3) * 12}%`,
              borderRadius: 'var(--radius-row)',
              background: 'var(--fill-quaternary)',
              animation: 'insights-pulse 1.6s var(--ease-out) infinite',
            }}
          />
          <div
            style={{
              width: 'var(--space-40)',
              height: 'var(--leading-body)',
              borderRadius: 'var(--radius-capsule)',
              background: 'var(--fill-quaternary)',
              animation: 'insights-pulse 1.6s var(--ease-out) infinite',
            }}
          />
        </div>
      ))}
    </div>
  );
}
