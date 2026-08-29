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

export type Locale = 'en' | 'es' | 'ru' | 'zh';

export const DEFAULT_LOCALE: Locale = 'en';

/* Ordered by the code, not by size or by how close a language is to English:
   a list whose order encodes a ranking of its entries invites the argument
   about the ranking. `zh` is the bare macrolanguage tag on purpose — Intl
   reads it as Simplified, which is what the catalogue is, and `pickLocale`
   matches on the primary subtag, so zh-CN and zh-TW both land here. A reader
   of Traditional gets Simplified rather than English; if that turns out to
   matter, the fix is a zh-Hant catalogue, not a narrower tag on this one. */
export const LOCALES: readonly LocaleInfo[] = [
  { code: 'en', label: 'English', short: 'EN' }, // i18n-exempt — see LocaleInfo.label
  { code: 'es', label: 'Español', short: 'ES' }, // i18n-exempt
  { code: 'ru', label: 'Русский', short: 'RU' }, // i18n-exempt
  { code: 'zh', label: '简体中文', short: 'ZH' }, // i18n-exempt
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
