/* i18n runtime for the renderer (TRA-379).

   Why i18next and not a hand-rolled lookup: plurals. Russian needs four forms
   where English needs two, and the correct way to pick one is Intl.PluralRules
   — which i18next already drives, along with interpolation and a runtime
   language switch. The parts we do not need (HTTP backends, language
   detectors, namespace lazy-loading) are separate packages we simply do not
   install, so what lands in the bundle is the resolver.

   Shape mirrors theme.ts on purpose: one localStorage key, absence means "not
   chosen yet, follow the system", and a `storage` listener keeps the menu
   window and the project windows on the same value. Anything a reader already
   understands about Appearance transfers here. */

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { useCallback, useEffect, useState } from 'react';
import { CATALOGS, NAMESPACES } from '../../shared/i18n/catalog/index.js';
import { DEFAULT_LOCALE, LOCALE_KEY, isLocale, pickLocale, type Locale } from '../../shared/i18n/locales.js';

export { LOCALES, type Locale } from '../../shared/i18n/locales.js';

/** The stored choice, or the best match for the system's languages. */
export function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* Private mode / disabled storage: fall through to the system's answer. */
  }
  return pickLocale(navigator.languages ?? [navigator.language]);
}

let started = false;

/** Idempotent: tests import the module per file and must not re-init. */
export function startI18n(locale: Locale = initialLocale()): typeof i18next {
  if (!started) {
    started = true;
    void i18next.use(initReactI18next).init({
      lng: locale,
      fallbackLng: DEFAULT_LOCALE,
      // Every namespace ships in the bundle, so there is nothing to load and no
      // suspense boundary to wait on it.
      resources: Object.fromEntries(
        Object.entries(CATALOGS).map(([code, catalog]) => [code, catalog]),
      ),
      ns: NAMESPACES as string[],
      defaultNS: 'common',
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  } else if (i18next.language !== locale) {
    void i18next.changeLanguage(locale);
  }
  applyLocale(i18next.language);
  return i18next;
}

/* `lang` on <html> is not decoration: it is what the OS spell-checker, the
   browser's hyphenation and a screen reader's voice selection read. */
function applyLocale(locale: string): void {
  if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', locale);
}

export function setLocale(next: Locale): void {
  try {
    localStorage.setItem(LOCALE_KEY, next);
  } catch {
    /* Not persisting is survivable; not switching is not. */
  }
  void i18next.changeLanguage(next);
  applyLocale(next);
  // The native menu and the tray are drawn by the main process, which cannot
  // read localStorage — same mirror `setAppearance` uses for the theme.
  window.electronAPI?.setLocale?.(next);
}

/** Current language plus the setter, and a re-render when either window changes it. */
export function useLocale(): { locale: Locale; setLocale: (next: Locale) => void } {
  const [locale, setCurrent] = useState<Locale>(() => {
    const active = i18next.language;
    return isLocale(active) ? active : DEFAULT_LOCALE;
  });

  useEffect(() => {
    const onChanged = (next: string): void => {
      if (isLocale(next)) setCurrent(next);
    };
    i18next.on('languageChanged', onChanged);
    return () => i18next.off('languageChanged', onChanged);
  }, []);

  // Cross-window, same contract as THEME_KEY.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== LOCALE_KEY || !isLocale(e.newValue)) return;
      void i18next.changeLanguage(e.newValue);
      applyLocale(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return { locale, setLocale: useCallback(setLocale, []) };
}

/** For module-level helpers that are not React components. Components should
    use `useTranslation` so they re-render when the language changes. */
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options) as string;
}

/** The active language, for the Intl formatters in ./format.ts. */
export function currentLocale(): Locale {
  return isLocale(i18next.language) ? i18next.language : DEFAULT_LOCALE;
}

export { i18next };

/* Started on import, not from main.tsx: a helper module that calls `t` at
   module scope (update-check.ts does) must not depend on the entry point
   having run first — and a test that renders one component in isolation gets
   real strings rather than raw keys. */
startI18n();
