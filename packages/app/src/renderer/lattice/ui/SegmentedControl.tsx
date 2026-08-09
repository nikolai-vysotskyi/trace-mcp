/* SegmentedControl.tsx — the island segmented/pill toggle (.ws-seg2).

   Replaces hand-rolled `<div className="ws-seg2"><button .s2 .is-active>…`
   blocks. Emits the canonical island.css markup verbatim, so swapping a call
   site to this component is a pure JSX dedup with zero visual change.

   `size="mini"` adds the `.mini` modifier (tighter padding / smaller text).
   Extra layout classes (e.g. the `ov2-seg` width tweak) pass through `className`
   so per-context sizing is preserved.

   For the NATIVE-WINDOW (.dlg) surface use DlgSegmented (.dlg-seg) instead. */

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
  size?: 'default' | 'mini';
  className?: string;
  'aria-label'?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'default',
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>): ReactNode {
  const cls = ['ws-seg2', size === 'mini' ? 'mini' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={'s2' + (opt.value === value ? ' is-active' : '')}
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
