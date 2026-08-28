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
  /**
   * Inline variant for an empty section INSIDE a card, rather than an empty
   * pane. The hero proportions (46px glyph, 17px title, 40px padding) build a
   * ~186px block around one sentence, which dwarfs the section it sits in.
   */
  compact?: boolean;
  className?: string;
  /** Plain content (used when none of the structured props are given). */
  children?: ReactNode;
}

export function EmptyState({
  icon,
  iconSize,
  glyph,
  title,
  subtitle,
  action,
  compact = false,
  className,
  children,
}: EmptyStateProps): ReactNode {
  iconSize ??= compact ? 20 : 40;
  const cls =
    'ws-center-empty' + (compact ? ' compact' : '') + (className ? ' ' + className : '');
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
