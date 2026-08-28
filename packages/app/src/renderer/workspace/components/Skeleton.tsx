/**
 * Skeleton — loading placeholders at the exact geometry of the final content.
 *
 * A centred spinner or the word "Loading…" tells the user nothing about what
 * is coming and makes the whole layout jump when data lands. These blocks sit
 * where the real value will sit, so nothing moves on arrival.
 */
import type { CSSProperties } from 'react';

export interface SkeletonProps {
  width: number | string;
  height: number;
  radius?: number;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width, height, radius = 4, className, style }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`ws-skel${className ? ` ${className}` : ''}`}
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/**
 * Placeholder rows for the project table, rendered at the real row height so
 * the table does not reflow when the first response lands.
 */
export function SkeletonTableRows({ rows, rowHeight }: { rows: number; rowHeight: number }) {
  return (
    <div role="status" aria-label="Loading projects">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 px-3"
          style={{ height: rowHeight, borderBottom: '0.5px solid var(--separator)' }}
        >
          <Skeleton width={14} height={14} radius={3} />
          <div className="flex flex-col gap-1">
            <Skeleton width={120 + ((i * 37) % 60)} height={11} />
            <Skeleton width={180 + ((i * 53) % 90)} height={9} />
          </div>
          <Skeleton width={64} height={11} style={{ marginLeft: 'auto' }} />
          <Skeleton width={48} height={11} />
          <Skeleton width={48} height={11} />
        </div>
      ))}
    </div>
  );
}
