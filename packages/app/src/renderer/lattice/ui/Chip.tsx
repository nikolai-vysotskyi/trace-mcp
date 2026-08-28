/* Chip.tsx — filter chips (TRA-290).

   Capsule, 24px minimum (they used to render at 21.5px, under the hit-target
   floor), 12px label. Idle --fill-quaternary → selected --fill-tertiary with a
   --label label. Accent fill is reserved for `single`-select groups, where
   exactly one chip is on at a time and the fill is unambiguous.

   ChipGroup exists because a bare row of `A B C D F` is unreadable without
   prior knowledge: the group carries a visible label, and each chip carries a
   `title` spelling out what it filters. */

import type { ReactNode } from 'react';

export interface ChipProps {
  label: ReactNode;
  selected: boolean;
  onClick: () => void;
  /** Single-select group — the selected chip gets the accent fill. */
  single?: boolean;
  title?: string;
  'aria-label'?: string;
  disabled?: boolean;
}

export function Chip({
  label,
  selected,
  onClick,
  single = false,
  title,
  'aria-label': ariaLabel,
  disabled,
}: ChipProps): ReactNode {
  const cls = ['lx-chip', single ? 'single' : '', selected ? 'is-on' : ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export interface ChipGroupProps {
  /** Visible group label — required; a row of bare chips has no affordance. */
  label: string;
  children: ReactNode;
}

export function ChipGroup({ label, children }: ChipGroupProps): ReactNode {
  return (
    <span className="lx-chip-group" role="group" aria-label={label}>
      <span className="lx-chip-group-label">{label}</span>
      <span className="lx-chip-row">{children}</span>
    </span>
  );
}
