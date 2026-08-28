/**
 * KpiTile — one dashboard metric, in card anatomy order:
 *
 *   label → value → comparison
 *
 * Cards are content, not chrome: opaque surface, 12px radius, hairline border,
 * no shadow and no glass. Status is never carried by colour alone — the tone
 * always arrives with a glyph and a written label.
 */
import type { ReactNode } from 'react';
import { Icon } from '../../lattice/icons';
import { Skeleton } from './Skeleton';

export type KpiTone = 'ok' | 'warn' | 'busy';

export interface KpiTileProps {
  label: string;
  value: number;
  /** Humanize large counts ("97.7k") instead of "97,712". */
  compact?: boolean;
  /** Change against the stored baseline. `null` = no baseline yet. */
  delta?: number | null;
  /** What the delta is measured against, e.g. "vs yesterday". */
  deltaCaption?: string;
  /** Comparison shown when there is no delta, e.g. "36% of 116 projects". */
  footnote?: string;
  tone?: KpiTone;
  active?: boolean;
  onClick?: () => void;
  /** The number isn't known yet — render skeletons at the final geometry. */
  pending?: boolean;
}

const TONE_ICON: Record<KpiTone, string> = {
  ok: 'check',
  warn: 'warning',
  busy: 'refresh',
};

const TONE_COLOR: Record<KpiTone, string> = {
  ok: 'var(--success)',
  warn: 'var(--warning)',
  busy: 'var(--accent)',
};

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function DeltaChip({ delta, caption }: { delta: number; caption?: string }): ReactNode {
  if (delta === 0) {
    return (
      <span style={{ color: 'var(--text-tertiary)' }}>
        No change{caption ? ` ${caption}` : ''}
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className="inline-flex items-center gap-0.5 tabular-nums"
      style={{ color: up ? 'var(--success)' : 'var(--destructive)' }}
    >
      {/* Arrow glyph as well as colour — the direction must survive a
          colour-blind reading and a greyscale screenshot. */}
      <span aria-hidden="true">{up ? '↑' : '↓'}</span>
      {up ? '+' : '−'}
      {formatCompact(Math.abs(delta))}
      {caption ? <span style={{ color: 'var(--text-tertiary)' }}> {caption}</span> : null}
    </span>
  );
}

export function KpiTile({
  label,
  value,
  compact = false,
  delta = null,
  deltaCaption,
  footnote,
  tone,
  active = false,
  onClick,
  pending = false,
}: KpiTileProps) {
  const interactive = onClick !== undefined;
  const valueColor = tone ? TONE_COLOR[tone] : 'var(--text-primary)';

  return (
    <button
      type="button"
      disabled={!interactive}
      aria-pressed={interactive ? active : undefined}
      data-kpi={label}
      onClick={onClick}
      className="flex flex-col items-start gap-1 text-left transition-colors"
      style={{
        minWidth: 132,
        flex: '1 1 132px',
        padding: 16,
        borderRadius: 12,
        background: active ? 'var(--bg-active)' : 'var(--bg-grouped)',
        border: `0.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        cursor: interactive ? 'pointer' : 'default',
      }}
    >
      <span
        className="inline-flex items-center gap-1 text-[11px] leading-[13px] font-medium"
        style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)' }}
      >
        {tone ? <Icon name={TONE_ICON[tone]} size={11} /> : null}
        {label}
      </span>

      {pending ? (
        <Skeleton width={72} height={26} radius={6} style={{ margin: '3px 0' }} />
      ) : (
        <span
          data-kpi-value=""
          className="tabular-nums"
          style={{
            fontSize: 28,
            lineHeight: '32px',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: valueColor,
          }}
        >
          {compact ? formatCompact(value) : value.toLocaleString()}
        </span>
      )}

      {pending ? (
        <Skeleton width={92} height={11} />
      ) : (
        <span className="text-[11px] leading-[13px]" style={{ color: 'var(--text-tertiary)' }}>
          {delta !== null ? <DeltaChip delta={delta} caption={deltaCaption} /> : footnote}
        </span>
      )}
    </button>
  );
}
