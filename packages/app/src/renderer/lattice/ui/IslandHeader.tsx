/* IslandHeader.tsx — the canonical island header row (.ws-island-head).

   Every island (Project tree, Commit, Database, Terminal, …) renders the same
   strict 38px header: a leading title (optional icon + chevron) and a trailing
   actions cluster of .ws-mini buttons. This component owns that contract so the
   rows stay pixel-identical; actions are supplied as children (use <Button
   variant="mini" …/> or <MiniButton/>).

   The matching `MiniButton` helper covers the common icon-action case. */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from '../icons';

export interface IslandHeaderProps {
  title: ReactNode;
  /** Leading icon name shown before the title. */
  icon?: string;
  /** Show a disclosure chevron after the title (collapsible islands). */
  chevron?: boolean;
  /** Trailing action cluster (typically <MiniButton/>s). */
  actions?: ReactNode;
  /** onClick for the title (collapsible toggle). */
  onTitleClick?: () => void;
  className?: string;
}

export function IslandHeader({
  title,
  icon,
  chevron = false,
  actions,
  onTitleClick,
  className,
}: IslandHeaderProps): ReactNode {
  return (
    <div className={'ws-island-head' + (className ? ' ' + className : '')}>
      <span
        className="ws-island-title"
        onClick={onTitleClick}
        style={onTitleClick ? { cursor: 'default' } : undefined}
      >
        {icon ? <Icon name={icon} size={15} /> : null}
        {title}
        {chevron ? (
          <span className="chev">
            <Icon name="expand_more" size={14} />
          </span>
        ) : null}
      </span>
      {actions ? <div className="ws-island-actions">{actions}</div> : null}
    </div>
  );
}

export interface MiniButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  iconSize?: number;
}

/** A 24px icon action button (.ws-mini) for island headers / toolbars. */
export function MiniButton({
  icon,
  iconSize = 15,
  className,
  type = 'button',
  ...rest
}: MiniButtonProps): ReactNode {
  return (
    <button type={type} className={'ws-mini' + (className ? ' ' + className : '')} {...rest}>
      <Icon name={icon} size={iconSize} />
    </button>
  );
}
