/* Checkbox.tsx — macOS checkbox (TRA-290).

   16×16 visual inside a 24×24 hit target; accent fill + white checkmark when
   on. The geometry lives in controls.css and applies to EVERY
   `input[type=checkbox]` in the renderer — the workspace table alone renders
   ~90 of them and they were 13×13 UA defaults. This component exists for the
   `indeterminate` state, which HTML can only set from script. */

import { useEffect, useRef, type ReactNode } from 'react';

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Mixed state — some but not all of the group is selected. */
  indeterminate?: boolean;
  'aria-label': string;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  indeterminate = false,
  'aria-label': ariaLabel,
  disabled,
  className,
}: CheckboxProps): ReactNode {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className={className}
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}
