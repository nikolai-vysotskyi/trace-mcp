/* locales.ts — which languages the app ships, in one list (TRA-379).

   Shared rather than renderer-local for the same reason global-actions.ts is:
   the native application menu is built in the main process and the in-app menu
   in the renderer, and a list of languages that exists twice drifts.

   English is the source language: every key is authored in en/ and the other
   catalogues are typed against it, so a missing translation is a compile error
   rather than a key leaking into the UI. */

export interface LocaleInfo {
  code: Locale;
  /** The language's own name — a language list is one of the few places where
      translating the entries is wrong: someone looking for Russian is looking
      for "Русский", not for whatever the current language calls it. */
  label: string;
  /** Two letters, for surfaces that can only spend a segment on it. */
  short: string;
}

export type Locale = 'en' | 'ru';

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'en', label: 'English', short: 'EN' }, // i18n-exempt — see LocaleInfo.label
  { code: 'ru', label: 'Русский', short: 'RU' }, // i18n-exempt
];

/** Same shape as THEME_KEY: one localStorage key, absent means "not chosen". */
export const LOCALE_KEY = 'trace-mcp-locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.some((l) => l.code === value);
}

/**
 * First supported language among the user's preferences, else English.
 * Matches on the primary subtag, so `ru-RU` and `ru` both land on Russian.
 */
export function pickLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    const hit = LOCALES.find((l) => l.code === base);
    if (hit) return hit.code;
  }
  return DEFAULT_LOCALE;
}
