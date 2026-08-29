/* SidebarRow.tsx — the sidebar's one row (TRA-305, extracted in TRA-363).

   28px tall, 16px leading glyph, 13px label; `.ws-sb-row` in styles/sidebar.css
   carries the geometry. It lived in App.tsx while App.tsx was its only caller;
   the sidebar's app menu is a second one, and the alternative was importing
   from App.tsx, which imports the menu — a cycle. */

import type React from 'react';
import { Icon } from '../lattice/icons';

export function SidebarRow({
  icon,
  glyph,
  label,
  selected = false,
  onClick,
  onKeyDown,
  onContextMenu,
  title,
  count,
  trailing,
  rowRef,
  ...aria
}: {
  icon?: string;
  glyph?: React.ReactNode;
  label: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
  count?: React.ReactNode;
  trailing?: React.ReactNode;
  rowRef?: React.Ref<HTMLButtonElement>;
} & React.AriaAttributes & { role?: string; tabIndex?: number }) {
  return (
    <button
      type="button"
      ref={rowRef}
      className={`ws-sb-row${selected ? ' is-selected' : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      title={title}
      {...aria}
    >
      <span className="ws-sb-ico" aria-hidden="true">
        {glyph ?? (icon ? <Icon name={icon} size={16} /> : null)}
      </span>
      {typeof label === 'string' ? <span className="ws-sb-label">{label}</span> : label}
      {count !== undefined && <span className="ws-sb-count">{count}</span>}
      {trailing}
    </button>
  );
}
