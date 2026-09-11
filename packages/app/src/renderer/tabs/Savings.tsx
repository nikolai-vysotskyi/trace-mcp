/**
 * Savings — what trace-mcp gave back to this install (TRA-1091).
 *
 * The whole screen is one figure and the sentences that keep it honest. Eleven
 * free tools measure what an agent *spends*; none of them shows what anything
 * gave back, and trace-mcp had the number and showed it to nobody — it went
 * into the usage ping and stopped there.
 *
 * The renderer computes nothing. `GET /api/savings` returns
 * `src/savings-report.ts`'s report and every field below is printed from it,
 * because the reason this screen exists is that the previous figure was
 * `calls x constant` (TRA-880) and a second implementation is how that comes
 * back.
 *
 * Three states, all designed, none of them a spinner:
 *   loading        — skeleton rows at the final geometry
 *   enough_data    — the figure, its parts, and what it excludes
 *   !enough_data   — an empty state that says "not enough measured calls yet"
 *                    and prints no number. Not a zero, not an extrapolation.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DaemonDownPane } from '../components/DaemonDownPane';
import { daemonFetch, BASE } from '../daemon-fetch';
import { useDaemon } from '../hooks/useDaemon';
import { formatNumber } from '../i18n/format';
import { Button, Card, EmptyState, ListRow, Section, SkeletonRows, Toolbar } from '../lattice/ui';
import { useUsefulPaint } from '../perf';

interface SavingsReport {
  enough_data: boolean;
  calls: number;
  unmeasured_calls: number;
  baseline_tokens: number;
  response_tokens: number;
  tokens_saved: number;
  reduction_pct: number;
  usd_saved_floor: number;
  price_model: string;
  price_per_mtok_usd: number;
  model_source?: 'detected' | 'fallback';
  since: string | null;
  methodology_url: string;
  reason?: string;
}

/** "1.2M", "48.3K", "912" — a dashboard number, never a raw 1204831. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${formatNumber(Math.round(n / 100_000) / 10)}M`;
  if (n >= 10_000) return `${formatNumber(Math.round(n / 1_000))}K`;
  return formatNumber(n);
}

export function Savings() {
  const { t } = useTranslation('savings');
  const { restarting, restartDaemon } = useDaemon();
  const [report, setReport] = useState<SavingsReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await daemonFetch(`${BASE}/api/savings`);
      if (!res.ok) throw new Error(String(res.status));
      setReport((await res.json()) as SavingsReport);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useUsefulPaint('savings', report !== null || failed);

  return (
    <div className="flex flex-col h-full min-h-0">
      <Toolbar scrolled={scrolled} className="gap-3">
        <h2
          className="flex-1 min-w-0 text-[15px] leading-5 font-semibold truncate"
          style={{ color: 'var(--label)', letterSpacing: '-0.01em' }}
        >
          {t('title')}
        </h2>
        <Button
          variant="icon"
          icon="refresh"
          onClick={() => void load()}
          aria-label={t('refresh')}
          title={t('refresh')}
        />
      </Toolbar>

      <div
        className="flex-1 overflow-auto"
        onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 0)}
      >
        {failed ? (
          <div className="flex items-center justify-center h-full">
            <DaemonDownPane restarting={restarting} onRestart={() => void restartDaemon()} />
          </div>
        ) : (
          <div className="flex flex-col gap-6 px-4 py-4 mx-auto w-full" style={{ maxWidth: 640 }}>
            {report === null ? (
              <Card>
                <SkeletonRows rows={5} />
              </Card>
            ) : report.enough_data ? (
              <SavingsFigure report={report} />
            ) : (
              <EmptyState
                icon="savings"
                title={t('notEnoughTitle')}
                subtitle={report.reason ?? t('notEnoughSubtitle')}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SavingsFigure({ report: r }: { report: SavingsReport }) {
  const { t } = useTranslation('savings');
  return (
    <>
      {/* The figure. One idea: tokens given back, priced at a floor. */}
      <Card>
        <div className="flex flex-col gap-1 px-4 py-4">
          <span
            className="text-[11px] leading-[13px] font-semibold"
            style={{ color: 'var(--label-secondary)' }}
          >
            {t('heroLabel')}
          </span>
          <span
            className="text-[32px] leading-9 font-semibold tabular-nums"
            style={{ color: 'var(--label)', letterSpacing: '-0.01em' }}
          >
            {t('heroValue', { tokens: compact(r.tokens_saved) })}
          </span>
          <span className="text-[13px] leading-4" style={{ color: 'var(--label-secondary)' }}>
            {r.model_source === 'detected'
              ? t('heroUsdDetected', {
                  usd: `$${r.usd_saved_floor.toFixed(2)}`,
                  model: r.price_model,
                  rate: `$${r.price_per_mtok_usd.toFixed(2)}`,
                })
              : t('heroUsd', {
                  usd: `$${r.usd_saved_floor.toFixed(2)}`,
                  model: r.price_model,
                  rate: `$${r.price_per_mtok_usd.toFixed(2)}`,
                })}
          </span>
        </div>
      </Card>

      {/* Compared to what — the subtraction, spelled out. */}
      <Section title={t('sectionBreakdown')}>
        <Card>
          <ListRow label={t('rowBaseline')} value={compact(r.baseline_tokens)} />
          <ListRow label={t('rowReturned')} value={compact(r.response_tokens)} />
          <ListRow label={t('rowReduction')} value={`${r.reduction_pct}%`} />
          <ListRow label={t('rowCalls')} value={formatNumber(r.calls)} />
          {r.unmeasured_calls > 0 && (
            <ListRow label={t('rowExcluded')} value={formatNumber(r.unmeasured_calls)} />
          )}
          <ListRow
            label={t('rowSince')}
            value={r.since ? r.since.slice(0, 10) : t('unknown')}
            last
          />
        </Card>
      </Section>

      {/* The honesty boundary travels with the number, not a page away. */}
      <Section title={t('sectionMethod')}>
        <Card>
          <p
            className="px-3 py-3 text-[13px] leading-[18px]"
            style={{ color: 'var(--label-secondary)' }}
          >
            {t('methodBody')}
          </p>
          <div className="px-3 pb-3">
            <Button size="small" onClick={() => window.open(r.methodology_url, '_blank')}>
              {t('methodLink')}
            </Button>
          </div>
        </Card>
      </Section>
    </>
  );
}
