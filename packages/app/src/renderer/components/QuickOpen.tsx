/* QuickOpen.tsx — ⌘⇧O / ⌘P over the app's destinations (TRA-297).

   One field, one list, ↑↓ + ⏎, Esc to cancel. Deliberately not a command
   palette: it lists what the sidebar already offers — sections, recent
   projects, and (in a project window) indexed files — so the keyboard reaches
   the same places the mouse does, in one step instead of three.

   Filtering is a plain subsequence match on the label + detail, which is what
   makes "wtv" find "WorkspaceTableView" without a fuzzy-search dependency. */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../lattice/icons';

export interface QuickOpenItem {
  id: string;
  /** Primary line — what the user is looking for. */
  label: string;
  /** Secondary line: a path, a group name. Also searched. */
  detail?: string;
  /** Group header this item sits under. */
  group: string;
  icon: string;
  run: () => void;
}

/** Subsequence match, case-insensitive. Returns false when a query character
    never appears in order — the cheapest thing that behaves like a fuzzy
    matcher without pulling one in. */
export function matchesQuery(haystack: string, query: string): boolean {
  if (query === '') return true;
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const next = h.indexOf(ch, i);
    if (next === -1) return false;
    i = next + 1;
  }
  return true;
}

export function filterItems(items: QuickOpenItem[], query: string): QuickOpenItem[] {
  const trimmed = query.trim();
  if (trimmed === '') return items;
  return items.filter((item) => matchesQuery(`${item.label} ${item.detail ?? ''}`, trimmed));
}

export function QuickOpen({
  items,
  onClose,
}: {
  items: QuickOpenItem[];
  onClose: () => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const matches = useMemo(() => filterItems(items, query).slice(0, 60), [items, query]);

  // A shrinking result list must never leave the highlight past its end.
  const index = Math.min(active, Math.max(0, matches.length - 1));

  useEffect(() => {
    // `?.` on the call too: scrollIntoView is absent in jsdom, and an effect
    // that throws takes the whole panel down with it.
    listRef.current
      ?.querySelectorAll<HTMLElement>('.lx-qo-item')
      [index]?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(index + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(index - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = matches[index];
      if (!item) return;
      onClose();
      item.run();
    }
  };

  let lastGroup = '';

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim is a dismissal affordance, not a control — Escape on the field is the keyboard path.
    <div className="lx-sheet-scrim lx-qo-scrim" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick open"
        className="lx-qo"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lx-qo-field">
          <span className="lx-qo-glyph" aria-hidden="true">
            <Icon name="search" size={16} />
          </span>
          {/* biome-ignore lint/a11y/noAutofocus: a quick-open the user must click into is not a quick-open. */}
          <input
            autoFocus
            type="text"
            value={query}
            placeholder="Go to section, project or file"
            aria-label="Quick open"
            aria-controls={listId}
            aria-activedescendant={matches[index] ? `${listId}-${index}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="lx-qo-list" id={listId} role="listbox" aria-label="Results" ref={listRef}>
          {matches.length === 0 ? (
            <div className="lx-qo-empty">No matches</div>
          ) : (
            matches.map((item, i) => {
              const header = item.group !== lastGroup ? item.group : null;
              lastGroup = item.group;
              return (
                <div key={item.id}>
                  {header && <div className="lx-qo-group">{header}</div>}
                  <button
                    type="button"
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === index}
                    className={`lx-qo-item${i === index ? ' is-active' : ''}`}
                    onMouseMove={() => setActive(i)}
                    onClick={() => {
                      onClose();
                      item.run();
                    }}
                  >
                    <span className="lx-qo-ico" aria-hidden="true">
                      <Icon name={item.icon} size={16} />
                    </span>
                    <span className="lx-qo-label">{item.label}</span>
                    {item.detail && <span className="lx-qo-detail">{item.detail}</span>}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
