/**
 * Insights tab.
 *
 * Surfaces three high-value reports for a project:
 *   - CLAUDE.md drift (stale paths / dead symbols in agent config)
 *   - Top PageRank-central files (architectural importance)
 *   - Risk hotspots (high complexity × high git churn)
 *
 * Each report is a card on the left; clicking a card focuses it and
 * renders its rows in the detail panel on the right. Per-report refresh
 * + inline loading + error state. Read-only — no destructive tools.
 *
 * Visual style mirrors AskTab.tsx / Dashboard.tsx — same theme tokens,
 * spacing, and accent button. The renderer/runtime split (this file
 * vs insights-runtime.ts) follows the pattern established by R08
 * (Notebook) so the project-root vitest config can test pure logic
 * without pulling in React under pnpm --frozen-lockfile.
 */
import { useCallback, useState } from 'react';
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

  return (
    <div
      className="flex flex-col h-full"
      style={{ WebkitAppRegion: 'no-drag', overflow: 'hidden' } as React.CSSProperties}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {/* Header */}
      <div
        style={{
          padding: '10px 14px 8px',
          borderBottom: '0.5px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Insights</div>
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>
          High-signal project reports. Click a card to focus, then Run.
        </div>
      </div>

      {/* Two-column body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left: report card list */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: '0.5px solid var(--border)',
            overflowY: 'auto',
            padding: '10px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {INSIGHT_REPORTS.map((r) => {
            const st = states[r.id];
            const isFocused = focused === r.id;
            const count = st.rows?.rows.length ?? null;
            return (
              <div
                key={r.id}
                style={{
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: isFocused ? 'var(--bg-active)' : 'var(--bg-grouped)',
                  border: '0.5px solid var(--border)',
                  boxShadow: 'var(--shadow-grouped)',
                  cursor: 'pointer',
                }}
                onClick={() => setFocused(r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setFocused(r.id);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-pressed={isFocused}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      flex: 1,
                    }}
                  >
                    {r.title}
                  </span>
                  {count !== null && (
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: 'monospace',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      {count}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--text-secondary)',
                    marginBottom: 8,
                    lineHeight: 1.4,
                  }}
                >
                  {r.description}
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFocused(r.id);
                    runReport(r.id);
                  }}
                  disabled={st.status === 'running'}
                  style={{
                    padding: '4px 12px',
                    fontSize: 11,
                    fontWeight: 500,
                    borderRadius: 6,
                    background: st.status === 'running' ? 'var(--fill-control)' : 'var(--accent)',
                    color: st.status === 'running' ? 'var(--text-tertiary)' : '#fff',
                    border: 'none',
                    cursor: st.status === 'running' ? 'default' : 'pointer',
                    boxShadow: 'var(--shadow-control)',
                    fontFamily: 'inherit',
                  }}
                >
                  {st.status === 'running' ? 'Running…' : st.status === 'ok' ? 'Refresh' : 'Run'}
                </button>
              </div>
            );
          })}
        </div>

        {/* Right: detail panel */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              {focusedDef.title}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', flex: 1 }}>
              tool: <span style={{ fontFamily: 'monospace' }}>{focusedDef.mcpTool}</span>
            </div>
            <button
              type="button"
              onClick={() => runReport(focused)}
              disabled={focusedState.status === 'running'}
              style={{
                padding: '4px 12px',
                fontSize: 11,
                fontWeight: 500,
                borderRadius: 6,
                background:
                  focusedState.status === 'running' ? 'var(--fill-control)' : 'var(--accent)',
                color: focusedState.status === 'running' ? 'var(--text-tertiary)' : '#fff',
                border: 'none',
                cursor: focusedState.status === 'running' ? 'default' : 'pointer',
                boxShadow: 'var(--shadow-control)',
                fontFamily: 'inherit',
              }}
            >
              {focusedState.status === 'running'
                ? 'Running…'
                : focusedState.status === 'ok'
                  ? 'Refresh'
                  : 'Run'}
            </button>
          </div>

          {focusedState.status === 'idle' && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              Click Run to generate this report.
            </div>
          )}
          {focusedState.status === 'running' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Spinner />
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                Calling {focusedDef.mcpTool}…
              </span>
            </div>
          )}
          {focusedState.status === 'error' && (
            <div
              role="alert"
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                fontSize: 11,
                color: 'var(--destructive)',
                background: 'rgba(255,59,48,0.06)',
                border: '0.5px solid rgba(255,59,48,0.15)',
              }}
            >
              {focusedState.error}
            </div>
          )}
          {focusedState.status === 'ok' && focusedState.rows && (
            <RowsView rows={focusedState.rows} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Rows view ────────────────────────────────────────────────────────

function RowsView({ rows }: { rows: InsightRows }) {
  if (rows.rows.length === 0) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
        No findings — this report came back empty.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.rows.map((row, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are reconstructed wholesale on each refresh, index is stable within a render.
          key={i}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '6px 10px',
            borderRadius: 6,
            background: 'var(--bg-grouped)',
            border: '0.5px solid var(--border)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                fontFamily: 'monospace',
                color: 'var(--text-primary)',
                wordBreak: 'break-all',
              }}
            >
              {row.primary}
            </div>
            {row.secondary && (
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--text-tertiary)',
                  marginTop: 2,
                }}
              >
                {row.secondary}
              </div>
            )}
          </div>
          {row.badge && (
            <span
              style={{
                fontSize: 10,
                padding: '2px 6px',
                borderRadius: 4,
                background: 'var(--fill-control)',
                color: 'var(--text-secondary)',
                border: '0.5px solid var(--border)',
                fontFamily: 'monospace',
                flexShrink: 0,
              }}
            >
              {row.badge}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        border: '1.5px solid var(--border)',
        borderTopColor: 'var(--accent)',
        animation: 'spin 0.8s linear infinite',
        display: 'inline-block',
      }}
      aria-hidden="true"
    />
  );
}
