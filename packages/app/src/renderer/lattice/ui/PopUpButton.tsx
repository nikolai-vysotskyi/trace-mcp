/* PopUpButton.tsx — macOS pop-up button (TRA-290).

   24px bordered capsule, 13px label, chevron-up-down glyph. Wraps a real
   <select>, because the native menu IS the platform menu — only the chrome is
   ours. Replaces the `appearance: none` 10px <select> with a hand-drawn sort
   glyph in the sidebar file explorer. */

import type { ReactNode } from 'react';

export interface PopUpOption<T extends string> {
  value: T;
  label: string;
}

export interface PopUpButtonProps<T extends string> {
  options: ReadonlyArray<PopUpOption<T>>;
  value: T;
  onChange: (next: T) => void;
  'aria-label': string;
  title?: string;
  className?: string;
  /** Stretch to the container width (sidebar sort picker does). */
  block?: boolean;
}

export function PopUpButton<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  title,
  className,
  block = false,
}: PopUpButtonProps<T>): ReactNode {
  const cls = ['lx-popup', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={cls} style={block ? { display: 'flex', width: '100%' } : undefined}>
      <select
        value={value}
        aria-label={ariaLabel}
        title={title ?? ariaLabel}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="lx-popup-chevron" aria-hidden="true">
        {/* chevron.up.chevron.down — the pop-up button's glyph, not a caret. */}
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 5.5 5 2.5l3 3M2 8.5l3 3 3-3" />
        </svg>
      </span>
    </span>
  );
}
