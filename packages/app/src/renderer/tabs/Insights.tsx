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
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUsefulPaint } from '../perf';
import { Badge, Button, EmptyState, PopUpButton, SegmentedControl, Toolbar } from '../lattice/ui';
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
  buildLoadToolsCall,
  flattenReport,
  flattenDriftRows,
  flattenPagerankRows,
  flattenRiskHotspotRows,
  flattenStartupContextRows,
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

/* The report picker is a segmented control while its segments fit, and a pop-up
   button when they do not — the macOS answer to a picker that outgrows its row.

   A segmented control cannot shrink: its segments are sized by their labels, so
   it is a single flex item wider than the line it sits on. The toolbar's
   `flex-wrap` (TRA-347) gives it its own row but cannot make it narrower, and
   the band clips. Measured on the running renderer at the 640px window minimum
   with the sidebar at its own maximum — both supported settings, `SIDEBAR_MAX`
   is 320 and the resizer's End key goes straight there — the 371px picker ran
   96.6px past the window's right edge and left "Risk hotspots" 14 of its 108px.
   That report could not be selected at all.

   The threshold is the control's own measured width, not a picked number, so
   retitling a report moves it on its own. */
export function pickerFits(availableW: number, intrinsicW: number): boolean {
  // Before either has been measured, assume it fits: the segmented control is
  // the richer control and the pop-up is the fallback, never the default.
  if (availableW <= 0 || intrinsicW <= 0) return true;
  return availableW >= intrinsicW;
}

/* Empty-state glyphs, one per report — a report pane with no data still needs
   geometry. Names come from lattice/icons.tsx. */
const REPORT_ICON: Record<ReportId, string> = {
  claudemd_drift: 'difference',
  pagerank: 'hub',
  risk_hotspots: 'bolt',
  startup_context: 'monitoring',
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
const RUNNING_KEY: Record<ReportId, string> = {
  claudemd_drift: 'runningDrift',
  pagerank: 'runningPagerank',
  risk_hotspots: 'runningRisk',
  startup_context: 'runningStartup',
};

// ── Component ────────────────────────────────────────────────────────

export function Insights({
  root,
  client = defaultInsightsClient,
}: {
  root: string;
  client?: InsightsClient;
}) {
  const { t } = useTranslation('insights');
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
          [id]: {
            ...prev[id],
            status: 'error',
            error: (err as Error).message ?? t('unknownError'),
          },
        }));
      }
    },
    [client, root, t],
  );

  /* Measure the toolbar, not the picker's own slot. The slot is narrower when
     it shares the line with the title and full-width once the picker wraps to
     a line of its own — so a slot-based threshold is bistable: at the same
     window and sidebar size, "segments, wrapped" and "pop-up, inline" are both
     self-consistent, and which one you get depends on the order the user
     resized in. The toolbar's width is the one number the picker cannot
     influence, and it is also the real constraint: the segments are usable if
     they fit a full line, since `flex-wrap` will give them one. */
  const pickerRef = useRef<HTMLSpanElement>(null);
  const intrinsicW = useRef(0);
  const [availW, setAvailW] = useState(0);
  const segmented = pickerFits(availW, intrinsicW.current);

  useEffect(() => {
    const bar = pickerRef.current?.closest('[role="toolbar"]');
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setAvailW((prev) => (prev === w ? prev : w));
    });
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  /* Record the segments' own width while they are on screen — after the swap
     they are gone. Measure the control, not the slot: the segmented control is
     `flex-shrink: 0`, so its box is its intrinsic width at any slot size, while
     the slot's `scrollWidth` collapses to the slot's own width whenever there
     is room to spare and would ratchet the threshold up until the segments
     could never come back. */
  useEffect(() => {
    const seg = pickerRef.current?.querySelector('.lx-seg');
    if (seg) {
      const w = Math.round(seg.getBoundingClientRect().width);
      if (w > 0) intrinsicW.current = w;
    }
  });

  const focusedDef = REPORT_BY_ID[focused];
  const focusedState = states[focused];
  const running = focusedState.status === 'running';
  const runLabel = running ? t('running') : focusedState.status === 'ok' ? t('refresh') : t('run');

  /* Reports run on demand, so the screen is useful the moment the picker
     and the empty state are up — there is nothing to wait for. */
  useUsefulPaint('insights', !running);

  return (
    <div
      className="flex flex-col h-full"
      style={{ WebkitAppRegion: 'no-drag', overflow: 'hidden' } as React.CSSProperties}
    >
      {/* Toolbar — title, report picker, the single primary action. */}
      <Toolbar className="gap-3">
        <h1 className="t-title-3" style={{ color: 'var(--label)', margin: 0, flexShrink: 0 }}>
          {t('title')}
        </h1>
        <span ref={pickerRef} style={{ display: 'flex', flex: '1 1 auto', minWidth: 0 }}>
          {segmented ? (
            <SegmentedControl
              aria-label={t('reportPicker')}
              value={focused}
              onChange={setFocused}
              options={INSIGHT_REPORTS.map((r) => ({
                value: r.id,
                label: t(r.titleKey),
                title: t(r.descriptionKey),
              }))}
            />
          ) : (
            <PopUpButton
              aria-label={t('reportPicker')}
              value={focused}
              onChange={setFocused}
              options={INSIGHT_REPORTS.map((r) => ({ value: r.id, label: t(r.titleKey) }))}
            />
          )}
        </span>
        {/* One Run on screen at a time: while the report has never been run,
            the empty state below carries it — repeating it here would put two
            accent-filled buttons on one screen for one command. */}
        {focusedState.status !== 'idle' && (
          <Button
            variant="prominent"
            onClick={() => runReport(focused)}
            disabled={running}
            aria-label={t('runAction', { action: runLabel, report: t(focusedDef.titleKey) })}
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
                {t(focusedDef.titleKey)}
              </div>
              <div className="t-body" style={{ color: 'var(--label-secondary)' }}>
                {t(focusedDef.descriptionKey)}
              </div>
            </div>
          )}

          {focusedState.status === 'idle' && (
            <EmptyState
              icon={REPORT_ICON[focused]}
              iconSize={32}
              title={t(focusedDef.titleKey)}
              subtitle={t(focusedDef.descriptionKey)}
              action={
                <Button variant="prominent" size="large" onClick={() => runReport(focused)}>
                  {t('run')}
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
        {running ? t(RUNNING_KEY[focused]) : ''}
      </span>
    </div>
  );
}

// ── Rows view ────────────────────────────────────────────────────────

function RowsView({ rows, icon }: { rows: InsightRows; icon: string }) {
  const { t } = useTranslation('insights');
  if (rows.rows.length === 0) {
    return (
      <EmptyState icon={icon} iconSize={32} title={t('emptyTitle')} subtitle={t('emptyBody')} />
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
