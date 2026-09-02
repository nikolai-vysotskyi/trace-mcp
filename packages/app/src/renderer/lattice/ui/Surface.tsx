/* Surface.tsx — the skeleton every content surface is built from (TRA-294).

   Extracted from ProjectOverview (TRA-293), which proved the shapes; Activity
   and Memory are the second and third callers, so they move here rather than
   being copied twice more.

     <Toolbar>          52px glass row, one per surface, scroll-edge hairline
     <Section title>    11/600 header + whitespace grouping, no rules
     <Card>             CONTENT: opaque --surface, 12px radius, hairline,
                        no shadow and no backdrop-filter. Ever.
     <ListRow>          32px label/value row of a grouped list
     <SkeletonRows>     loading at the real geometry, so nothing shifts
     <SectionError>     "couldn't measure this" + the one action that helps
*/

import { createContext, useContext } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format';
import { Icon } from '../icons';
import { Skeleton } from '../../workspace/components/Skeleton';
import { Button } from './Button';

/* The window's single top band (DESIGN.md §6). App.tsx publishes the element
   that sits to the right of the sidebar toggle; a surface's Toolbar renders
   into it rather than drawing a second row underneath. Null outside the app
   shell — in a unit test, or anywhere the band does not exist — and then the
   toolbar falls back to drawing itself in place. */
const HeaderSlotContext = createContext<HTMLElement | null>(null);
export const HeaderSlotProvider = HeaderSlotContext.Provider;

/** The surface's one control row. ONE per surface — a second is a bug.
    Inside the app shell it IS the window's top band, sharing the line with the
    sidebar toggle (TRA-354); standalone it is a 52px glass row of its own.
    `scrolled` fades in the hairline instead of a permanent hard border.

    `min-height` and `flex-wrap`, never a fixed `height` (TRA-347). The pane is
    420px wide at the 640px window minimum, and a non-wrapping fixed-height row
    inside the pane's `overflow-x: hidden` does not shrink, does not scroll and
    does not clip — it just runs off the edge. Measured at 640x420 before this:
    Memory's row was 703px of content in 420px, which put its search field, its
    prominent "Add decision" and its overflow menu wholly outside the window
    with zero visible pixels and no scrollable ancestor to bring them back;
    Activity's was 506px, losing "Pause the live feed" and its overflow menu.
    The workspace toolbar had already been given this treatment on its own
    (TRA-292) — the rule just never reached the shared primitive. The same
    measurement on the band caught Graph's Fit / Live / ⋯ and the last segment
    of Insights' report picker; a wrapped line grows the band instead. */
export function Toolbar({
  scrolled = false,
  className,
  children,
}: {
  scrolled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const slot = useContext(HeaderSlotContext);
  const row = (
    <div
      role="toolbar"
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 py-2 shrink-0 relative${slot ? ' flex-1 min-w-0 self-stretch' : ' px-4 glass'}${className ? ` ${className}` : ''}`}
      style={{
        minHeight: slot ? undefined : 52,
        borderBottom: '0.5px solid transparent',
        borderBottomColor: scrolled ? 'var(--separator)' : 'transparent',
        transition: 'border-bottom-color var(--dur-standard) var(--ease-out)',
      }}
    >
      {children}
    </div>
  );
  return slot ? createPortal(row, slot) : row;
}

/** Vertical rule between toolbar clusters. 16px, hairline, decoration. */
export function ToolbarDivider() {
  return (
    <span
      aria-hidden="true"
      className="shrink-0"
      style={{ width: 1, height: 16, background: 'var(--separator)' }}
    />
  );
}

export function Section({
  title,
  count,
  trailing,
  children,
}: {
  title: string;
  count?: number;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1 min-h-6">
        <h3
          className="flex items-baseline gap-1.5 text-[11px] leading-[13px] font-semibold"
          style={{ color: 'var(--label-secondary)' }}
        >
          {title}
          {count !== undefined && count > 0 && (
            <span className="tabular-nums" style={{ color: 'var(--label-secondary)' }}>
              {formatNumber(count)}
            </span>
          )}
        </h3>
        {trailing}
      </div>
      {children}
    </section>
  );
}

/** Inset grouped-list container. Content, so: opaque, hairline, no shadow. */
export function Card({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`overflow-hidden${className ? ` ${className}` : ''}`}
      style={{
        background: 'var(--surface)',
        borderRadius: 12,
        border: '0.5px solid var(--separator)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** One label/value row of a grouped list. 32px, 13px both sides. */
export function ListRow({
  label,
  value,
  last = false,
}: {
  label: ReactNode;
  value: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-3"
      style={{
        minHeight: 32,
        borderBottom: last ? 'none' : '0.5px solid var(--separator)',
      }}
    >
      <span className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
        {label}
      </span>
      <span
        className="text-[13px] leading-4 tabular-nums truncate"
        style={{ color: 'var(--label-secondary)' }}
      >
        {value}
      </span>
    </div>
  );
}

/** Rows at the real 32px geometry so nothing moves when the data lands. */
export function SkeletonRows({ rows }: { rows: number }) {
  const { t } = useTranslation('ui');
  return (
    <div role="status" aria-label={t('loading')}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center justify-between px-3"
          style={{
            minHeight: 32,
            borderBottom: i === rows - 1 ? 'none' : '0.5px solid var(--separator)',
          }}
        >
          <Skeleton width={92 + ((i * 29) % 40)} height={11} />
          <Skeleton width={48 + ((i * 17) % 32)} height={11} />
        </div>
      ))}
    </div>
  );
}

/** Inline "we couldn't measure this" panel with the one action that helps.

    It names WHAT is missing and nothing else. It used to add "The daemon may
    still be indexing", which is a cause this primitive cannot know — on a
    project last indexed five days ago, with the daemon up and its Indexing KPI
    reading "nothing running", it was simply false (TRA-662). Retry is the next
    step, and it is right there. A caller that does know the cause says it in
    its own words, the way GuardSection does. */
export function SectionError({
  what,
  several = false,
  onRetry,
}: {
  what: string;
  /** `what` names more than one thing, so the sentence around it is plural.
      A separate key rather than an i18next plural: only the caller knows the
      list has two entries, the collapsed banner is never singular, and a
      `count` would demand `_few`/`_many` forms from Russian and Arabic for a
      distinction none of them make here. German is why this exists at all —
      "die Index-Übersicht und der Qualitätsscan **konnten** nicht geladen
      werden", against `konnte` for one. */
  several?: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation('ui');
  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <Icon name="warning" size={14} />
      <span className="text-[13px] leading-4 flex-1" style={{ color: 'var(--label-secondary)' }}>
        {t(several ? 'sectionsError' : 'sectionError', { what })}
      </span>
      <Button size="small" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}

/* Re-exported rather than moved: Skeleton is a general primitive with two
   existing importers, and a re-export gives every surface the one import path
   at the cost of a single line. */
export { Skeleton };
