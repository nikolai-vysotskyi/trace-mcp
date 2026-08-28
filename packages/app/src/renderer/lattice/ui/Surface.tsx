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

import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '../icons';
import { Skeleton } from '../../workspace/components/Skeleton';
import { Button } from './Button';

/** 52px glass toolbar. ONE per surface — a second control row is a bug.
    `scrolled` fades in the hairline instead of a permanent hard border. */
export function Toolbar({
  scrolled = false,
  className,
  children,
}: {
  scrolled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      className={`flex items-center gap-2 px-4 shrink-0 glass relative${className ? ` ${className}` : ''}`}
      style={{
        height: 52,
        borderBottom: '0.5px solid transparent',
        borderBottomColor: scrolled ? 'var(--separator)' : 'transparent',
        transition: 'border-bottom-color var(--dur-standard) var(--ease-out)',
      }}
    >
      {children}
    </div>
  );
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
              {count.toLocaleString()}
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
  return (
    <div role="status" aria-label="Loading">
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

/** Inline "we couldn't measure this" panel with the one action that helps. */
export function SectionError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <Icon name="warning" size={14} />
      <span className="text-[13px] leading-4 flex-1" style={{ color: 'var(--label-secondary)' }}>
        Couldn&apos;t load {what}. The daemon may still be indexing.
      </span>
      <Button size="small" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/* Re-exported rather than moved: Skeleton is a general primitive with two
   existing importers, and a re-export gives every surface the one import path
   at the cost of a single line. */
export { Skeleton };
