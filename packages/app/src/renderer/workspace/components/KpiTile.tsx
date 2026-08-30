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
import { useTranslation } from 'react-i18next';
import { t } from '../../i18n';
import { formatNumber } from '../../i18n/format';
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
  /**
   * The pane is too short or too narrow to spend 112px per tile. Collapses the
   * card to one 36px line — label at the leading edge, value at the trailing
   * edge — and drops the comparison. Six full tiles are 396px tall, which at
   * the app's 420px minimum window height leaves the toolbar and the whole
   * project list below the window edge with nothing to scroll (TRA-325).
   */
  dense?: boolean;
  active?: boolean;
  onClick?: () => void;
  /** The number isn't known yet — render skeletons at the final geometry. */
  pending?: boolean;
  /**
   * The fetch finished and failed, so the number is not coming. A skeleton
   * here would pulse forever and promise data that will never land; render an
   * em dash at the same geometry instead, which reads as "unknown".
   */
  unavailable?: boolean;
}

const TONE_ICON: Record<KpiTone, string> = {
  ok: 'check',
  warn: 'warning',
  busy: 'refresh',
};

const TONE_COLOR: Record<KpiTone, string> = {
  ok: 'var(--status-green)',
  warn: 'var(--status-orange)',
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
      <span style={{ color: 'var(--label-secondary)' }}>
        {caption ? t('workspace:kpiNoChangeVs', { caption }) : t('workspace:kpiNoChange')}
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className="inline-flex items-center gap-0.5 tabular-nums"
      style={{ color: up ? 'var(--status-green)' : 'var(--status-red)' }}
    >
      {/* Arrow glyph as well as colour — the direction must survive a
          colour-blind reading and a greyscale screenshot. */}
      <span aria-hidden="true">{up ? '↑' : '↓'}</span>
      {up ? '+' : '−'}
      {formatCompact(Math.abs(delta))}
      {caption ? <span style={{ color: 'var(--label-secondary)' }}> {caption}</span> : null}
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
  dense = false,
  active = false,
  onClick,
  pending = false,
  unavailable = false,
}: KpiTileProps) {
  const { t } = useTranslation('workspace');
  const interactive = onClick !== undefined;
  const valueColor = unavailable ? 'var(--label-secondary)' : tone ? TONE_COLOR[tone] : 'var(--label)';
  // Same card either way — only the wrapper differs.
  const shell = {
    'data-kpi': label,
    'data-dense': dense ? '' : undefined,
    className: dense
      ? 'flex flex-row items-baseline justify-between gap-2 text-left transition-colors'
      : 'flex flex-col items-start gap-1 text-left transition-colors',
    style: {
      // No `flex` basis: the strip is a grid whose track count already
      // guarantees at least 132px per tile, and a flex-grow here is what let
      // a last-row tile stretch to 5.5x its siblings (TRA-467). `minWidth: 0`
      // so a long footnote sizes to its track instead of widening it.
      minWidth: 0,
      padding: dense ? '8px 12px' : 16,
      borderRadius: 12,
      // `background` and the hover tint live in controls.css (`[data-kpi]`):
      // an inline shorthand here would set `background-image: none` inline,
      // which no stylesheet rule can then override. A card is content and
      // stays opaque --surface in both states — tinting the ACTIVE tile
      // pushed --label-secondary to 4.45:1 on its footnote, and that token
      // only clears 4.5 over an untinted surface. Selection is the accent
      // border + aria-pressed, which as a UI boundary needs only 3:1.
      border: `0.5px solid ${active ? 'var(--accent)' : 'var(--separator)'}`,
    },
  };

  const content = (
    <>
      {/* Active is signalled by the accent BORDER + aria-pressed, not by an
          accent label: --accent on the active tile's --fill-tertiary tint
          measures 3.28:1, and --badge-accent-fg only reaches 4.29:1. Promoting
          the label to --label instead is 10.02:1 and reads as selected. */}
      <span
        className="inline-flex items-center gap-1 text-[11px] leading-[13px] font-medium"
        style={{ color: active ? 'var(--label)' : 'var(--label-secondary)' }}
      >
        {tone ? <Icon name={TONE_ICON[tone]} size={11} /> : null}
        {label}
      </span>

      {/* `unavailable` outranks `pending`: a fetch that finished and failed is
          not still loading, so the skeleton must not win when both are set. */}
      {pending && !unavailable ? (
        dense ? (
          <Skeleton width={48} height={15} radius={4} />
        ) : (
          <Skeleton width={72} height={26} radius={6} style={{ margin: '3px 0' }} />
        )
      ) : (
        <span
          data-kpi-value=""
          className="tabular-nums"
          style={{
            fontSize: dense ? 15 : 28,
            lineHeight: dense ? '20px' : '32px',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: valueColor,
          }}
        >
          {unavailable ? (
            <span aria-label={t('kpiNotAvailable')}>—</span>
          ) : compact ? (
            formatCompact(value)
          ) : (
            formatNumber(value)
          )}
        </span>
      )}

      {/* The comparison line is the first thing to go when the pane is short:
          it is the tallest part of the tile and the only part a user can
          reconstruct by widening the window. The value never goes.

          Two lines are reserved whatever the string does. A tile is 132–214px
          wide and the catalogue runs +30% longer than English in German and
          Russian, so whether this wraps is not something the layout gets to
          assume — and `kpiStripHeight()` in Workspace.tsx sizes the whole strip
          off one constant tile height. Reserving the second line keeps that
          constant true in every language instead of only in English. */}
      {dense ? null : (
        <span
          className="text-[11px] leading-[13px]"
          style={{ color: 'var(--label-secondary)', minHeight: 26, display: 'block' }}
        >
          {/* `unavailable` outranks `pending`: a fetch that finished and failed
              is not still loading, so the skeleton must not win when both are
              set. And an unavailable tile says nothing here at all — the em
              dash above already reads as "unknown" and carries that as its
              accessible name, while this slot is for a comparison and a failure
              sentence is not one.

              Whenever a tile is unavailable, a surface that knows WHY is
              already on screen: the busy banner above the strip, or
              DaemonDownPane in the pane below. (`unavailable` is only reached
              through `metricsFailed`/`listFailed`, and both imply a non-`ok`
              daemonState — see `deriveDaemonState`.) Captioning each tile
              "Couldn't be measured" put four of those under a banner promising
              the numbers were on their way, and six over a pane already headed
              "The daemon isn't running" (TRA-488). One condition, one sentence
              — the rule TRA-469 and TRA-471 settled for the other surfaces. */}
          {pending && !unavailable ? (
            <Skeleton width={92} height={11} />
          ) : unavailable ? null : delta !== null ? (
            <DeltaChip delta={delta} caption={deltaCaption} />
          ) : (
            footnote
          )}
        </span>
      )}
    </>
  );

  /* A tile with no filter behind it is a readout, and a readout is content. It
     rendered as `<button disabled>` until TRA-475, which puts a number in the
     accessibility tree as a control the user is told they may not operate —
     there was never a control. Only a tile that filters the list is a button;
     everything else is a `<div>` and leaves the tree entirely. */
  return interactive ? (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      {...shell}
      // A `<button>` in Chromium is `cursor: default`; a card the size of this
      // one has to say it is clickable before the pointer is over it.
      className={`${shell.className} cursor-pointer`}
    >
      {content}
    </button>
  ) : (
    <div {...shell}>{content}</div>
  );
}
