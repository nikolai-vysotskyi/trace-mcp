/* Appearance: Auto / Light / Dark (TRA-305).

   Default = Auto, i.e. follow `prefers-color-scheme`. Picking Light or Dark
   stores that in localStorage and sets [data-theme] on <html>; tokens.css gives
   that attribute higher specificity than the @media rule, so the choice wins.
   Picking Auto REMOVES the key — absence of a stored value is what Auto means,
   so there is no third value to write and no way to get stuck on an override.

   Cross-window: when the menu and a project window are both open, a `storage`
   event syncs them (a cleared key arrives as newValue === null).

   Lives outside App.tsx so it is testable without pulling in the whole
   renderer — same reason sidebar-prefs.ts and recent-projects.ts do. */

import { useCallback, useEffect, useState } from 'react';

export const THEME_KEY = 'trace-mcp-theme';

/** The appearance actually being rendered. */
export type Theme = 'light' | 'dark';
/** What the user picked. `auto` = follow the system, and is the default. */
export type Appearance = 'auto' | Theme;

/* One list, two surfaces: Settings renders the labels, the app menu's row
   renders the icons (its segments are icon-only). Same anti-drift rule as
   src/shared/global-actions.ts — the values and their names are written once. */
export const APPEARANCE_OPTIONS: ReadonlyArray<{
  value: Appearance;
  label: string;
  icon: string;
}> = [
  { value: 'auto', label: 'Auto', icon: 'contrast' },
  { value: 'light', label: 'Light', icon: 'light_mode' },
  { value: 'dark', label: 'Dark', icon: 'dark_mode' },
];

export function readStoredAppearance(): Appearance {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(): {
  theme: Theme;
  appearance: Appearance;
  setAppearance: (next: Appearance) => void;
} {
  const [appearance, setStored] = useState<Appearance>(() => readStoredAppearance());
  const [system, setSystem] = useState<Theme>(() => systemTheme());

  // Apply / remove the data-theme attribute on every change.
  useEffect(() => {
    const html = document.documentElement;
    if (appearance === 'auto') html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', appearance);
  }, [appearance]);

  // Track the system theme — it still matters while the choice is Auto.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return;
      setStored(e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : 'auto');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setAppearance = useCallback((next: Appearance) => {
    try {
      if (next === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {}
    setStored(next);
  }, []);

  return { theme: appearance === 'auto' ? system : appearance, appearance, setAppearance };
}
