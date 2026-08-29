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
import { t } from './i18n';

export const THEME_KEY = 'trace-mcp-theme';

/** The appearance actually being rendered. */
export type Theme = 'light' | 'dark';
/** What the user picked. `auto` = follow the system, and is the default. */
export type Appearance = 'auto' | Theme;

/* One list, two surfaces: Settings renders the labels, the app menu's row
   renders the icons (its segments are icon-only). Same anti-drift rule as
   src/shared/global-actions.ts — the values and their names are written once.

   A function rather than a frozen array: the labels come from the catalogue,
   and a const would pin them to whichever language loaded first (TRA-387). */
export function appearanceOptions(): ReadonlyArray<{
  value: Appearance;
  label: string;
  icon: string;
}> {
  return [
    { value: 'auto', label: t('shell:themeAuto'), icon: 'contrast' },
    { value: 'light', label: t('shell:themeLight'), icon: 'light_mode' },
    { value: 'dark', label: t('shell:themeDark'), icon: 'dark_mode' },
  ];
}

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

  // Apply / remove the data-theme attribute on every change, and mirror the
  // choice to the main process: the sidebar's material is an NSVisualEffectView
  // and reads `nativeTheme`, which no CSS attribute can reach — a choice that
  // stops at the DOM leaves light-mode material behind dark-mode text (TRA-369).
  useEffect(() => {
    const html = document.documentElement;
    if (appearance === 'auto') html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', appearance);
    window.electronAPI?.setAppearance?.(appearance);
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
