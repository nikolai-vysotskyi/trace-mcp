/* SegmentedControl.tsx — the one segmented control (TRA-290).

   A real macOS track: recessed --fill-tertiary capsule, 2px inset, capsule
   thumb. The selected thumb is --surface with a hairline — NOT an accent fill,
   which reads as "toggled on" rather than "this segment is selected".

   Replaces every ad-hoc pill row in the app (Table|Compact, Decisions|Review|…,
   Debug|TODOs|…, Tool calls|AI calls, All|Errors). */

import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'small' | 'regular' | 'large';
  className?: string;
  'aria-label'?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'regular',
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>): ReactNode {
  const cls = ['lx-seg', `sz-${size}`, className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls} role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={'lx-seg-item' + (opt.value === value ? ' is-active' : '')}
          title={opt.title}
          disabled={opt.disabled}
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
