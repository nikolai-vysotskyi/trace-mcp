/* SearchField.tsx — the one search field (TRA-290).

   Capsule, 24px, 13px, leading 14px magnifier, --fill-tertiary fill, Esc clears.
   Replaces the six hand-rolled search inputs and the `.ws-sbar`
   centred-placeholder-that-slides-left animation, which animated `left` (a
   layout property) over 0.42s and matched nothing on the platform. */

import { useRef, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons';

export interface SearchFieldProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Fill the remaining width of a flex toolbar. */
  grow?: boolean;
  autoFocus?: boolean;
  className?: string;
  'aria-label'?: string;
  /** Escape hatch for surfaces that focus the field from a keyboard shortcut. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

export function SearchField({
  value,
  onChange,
  placeholder,
  grow = false,
  autoFocus = false,
  className,
  'aria-label': ariaLabel,
  inputRef: externalRef,
}: SearchFieldProps): ReactNode {
  const { t } = useTranslation('ui');
  // Resolved here rather than as a default parameter: the fallback is a
  // translation, and a default parameter would freeze the first language.
  placeholder ??= t('search');
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? localRef;
  const cls = ['lx-search', grow ? 'grow' : '', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <span className="lx-search-glyph" aria-hidden="true">
        <Icon name="search" size={14} />
      </span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          // Esc clears; if already empty let the event bubble (a parent sheet
          // or popover may want to close on it).
          if (value === '') return;
          e.preventDefault();
          e.stopPropagation();
          onChange('');
        }}
      />
      {value !== '' && (
        <button
          type="button"
          className="lx-btn v-icon sz-regular"
          aria-label={t('clearSearch')}
          title={t('clearSearch')}
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}
