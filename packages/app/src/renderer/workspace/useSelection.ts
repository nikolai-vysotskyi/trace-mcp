import { useCallback, useState } from 'react';

/**
 * Multi-select machinery for list/table views.
 *
 * Backed by a Set<string> of stable IDs. All mutators do immutable updates
 * so React diffs correctly. `getId` lets callers parameterise selection
 * over any row shape (typically `ProjectViewModel` → `root`).
 */
export interface SelectionApi<T> {
  selected: Set<string>;
  isSelected(id: string): boolean;
  toggle(id: string): void;
  set(id: string, selected: boolean): void;
  /** Replace the selection with the IDs of every item in `items`. */
  selectAll(items: T[]): void;
  clear(): void;
  count: number;
}

export function useSelection<T>(getId: (item: T) => string): SelectionApi<T> {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const set = useCallback((id: string, value: boolean) => {
    setSelected((prev) => {
      if (value === prev.has(id)) return prev;
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(
    (items: T[]) => {
      setSelected(new Set(items.map(getId)));
    },
    [getId],
  );

  const clear = useCallback(() => {
    setSelected((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  return {
    selected,
    isSelected,
    toggle,
    set,
    selectAll,
    clear,
    count: selected.size,
  };
}
