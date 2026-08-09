/* EmptyState.tsx — centered placeholder for empty / loading / error views
   (.ws-center-empty).

   Standardizes the "big glyph + title + subtitle + optional action" panel used
   across the editor center, panels, and views. Plain-text empties (e.g. a tree
   panel's "Loading files…") can keep passing just a string child; the richer
   form uses the icon/title/subtitle/action props. */

import type { ReactNode } from 'react';
import { Icon } from '../icons';

export interface EmptyStateProps {
  /** Leading icon name. Omit for a text-only empty state. */
  icon?: string;
  iconSize?: number;
  /** Custom glyph node (e.g. <AgentMark/>) — wins over `icon`. */
  glyph?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Call-to-action (e.g. <Button variant="primary"/>). */
  action?: ReactNode;
  className?: string;
  /** Plain content (used when none of the structured props are given). */
  children?: ReactNode;
}

export function EmptyState({
  icon,
  iconSize = 40,
  glyph,
  title,
  subtitle,
  action,
  className,
  children,
}: EmptyStateProps): ReactNode {
  const cls = 'ws-center-empty' + (className ? ' ' + className : '');
  if (children != null && !title && !subtitle && !icon && !glyph && !action) {
    return <div className={cls}>{children}</div>;
  }
  return (
    <div className={cls}>
      {glyph ? <span className="gi">{glyph}</span> : null}
      {!glyph && icon ? (
        <span className="gi">
          <Icon name={icon} size={iconSize} />
        </span>
      ) : null}
      {title ? <div className="t">{title}</div> : null}
      {subtitle ? <div className="s">{subtitle}</div> : null}
      {action}
      {children}
    </div>
  );
}
