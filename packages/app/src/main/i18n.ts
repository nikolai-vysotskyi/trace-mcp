/* i18n for the main process (TRA-386).

   i18next's core is framework-agnostic — react-i18next is a separate package we
   simply do not import here — and it is a runtime `dependency`, not a dev one,
   so it survives electron-builder packaging into the app bundle.

   `createInstance()` rather than the default export: the renderer has its own
   instance in another process entirely, and keeping them separate means a test
   that loads both modules in one vitest worker does not have them fight over a
   single global language. */

import i18next, { type i18n as I18n } from 'i18next';

import { CATALOGS, NAMESPACES } from '../shared/i18n/catalog/index.js';
import { DEFAULT_LOCALE, isLocale, type Locale } from '../shared/i18n/locales.js';

const instance: I18n = i18next.createInstance();
let started = false;

/** Idempotent: tests import this per file and must not re-init. */
export function startI18n(locale: Locale = DEFAULT_LOCALE): void {
  if (!started) {
    started = true;
    void instance.init({
      lng: locale,
      fallbackLng: DEFAULT_LOCALE,
      resources: CATALOGS,
      ns: NAMESPACES as string[],
      defaultNS: 'common',
      interpolation: { escapeValue: false },
      returnNull: false,
      initImmediate: false,
    });
  } else if (instance.language !== locale) {
    void instance.changeLanguage(locale);
  }
}

/** Namespaced key — `t('menu:file')`. There are no React components here, so
    there is no `useTranslation` and every caller reads the current language at
    the moment it builds a menu. */
export function t(key: string, options?: Record<string, unknown>): string {
  if (!started) startI18n();
  return instance.t(key, options) as string;
}

export function currentLocale(): Locale {
  return isLocale(instance.language) ? instance.language : DEFAULT_LOCALE;
}
