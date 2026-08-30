/* locales.ts — which languages the app ships, in one list (TRA-379, TRA-450).

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
  /** The same language named in English, shown beside the own name. Someone has
      to be able to navigate past five scripts they cannot read to find their
      way back, and "Chinese (Simplified)" is the only handle they have. */
  englishLabel: string;
}

/* Bare language subtags, with one exception. `zh` is the macrolanguage tag on
   purpose (TRA-389): Intl reads it as Simplified, which is what the catalogue
   is, and a reader of Traditional gets Simplified rather than English — if that
   turns out to matter the fix is a zh-Hant catalogue, not a narrower tag on
   this one. `pt-BR` IS narrowed, because the Brazilian and European catalogues
   would genuinely differ and the one we wrote is Brazilian. */
export type Locale =
  | 'en'
  | 'de'
  | 'es'
  | 'fr'
  | 'hi'
  | 'ja'
  | 'ko'
  | 'pt-BR'
  | 'ru'
  | 'zh';

export const DEFAULT_LOCALE: Locale = 'en';

/* English first because it is the source language and the fallback, then by
   code. That is a rule rather than a ranking, which is the point: an order that
   encodes how important each language is only invites the argument about the
   ranking, and it would have to be re-argued every time the list grows. Which
   languages are HERE is the judgement call — ten, weighted to the developer
   audience; where each one sits in the list is not. */
export const LOCALES: readonly LocaleInfo[] = [
  { code: 'en', label: 'English', englishLabel: 'English' }, // i18n-exempt — see LocaleInfo.label
  { code: 'de', label: 'Deutsch', englishLabel: 'German' }, // i18n-exempt
  { code: 'es', label: 'Español', englishLabel: 'Spanish' }, // i18n-exempt
  { code: 'fr', label: 'Français', englishLabel: 'French' }, // i18n-exempt
  { code: 'hi', label: 'हिन्दी', englishLabel: 'Hindi' }, // i18n-exempt
  { code: 'ja', label: '日本語', englishLabel: 'Japanese' }, // i18n-exempt
  { code: 'ko', label: '한국어', englishLabel: 'Korean' }, // i18n-exempt
  { code: 'pt-BR', label: 'Português (Brasil)', englishLabel: 'Portuguese (Brazil)' }, // i18n-exempt
  { code: 'ru', label: 'Русский', englishLabel: 'Russian' }, // i18n-exempt
  { code: 'zh', label: '简体中文', englishLabel: 'Chinese (Simplified)' }, // i18n-exempt
];

/** Same shape as THEME_KEY: one localStorage key, absent means "not chosen". */
export const LOCALE_KEY = 'trace-mcp-locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.some((l) => l.code === value);
}

const primary = (tag: string): string => tag.toLowerCase().split('-')[0];

/**
 * First supported language among the user's preferences, else English.
 *
 * Two passes, not one per tag. An exact tag anywhere in the list beats a
 * language-only guess earlier in it, so `['pt-PT', 'en']` lands on English
 * rather than silently handing a Portuguese reader the Brazilian catalogue —
 * they said what their second choice was. `['pt-PT']` alone still gets `pt-BR`,
 * because the alternative there is English, which is further away.
 */
export function pickLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const hit = LOCALES.find((l) => l.code.toLowerCase() === tag.toLowerCase());
    if (hit) return hit.code;
  }
  for (const tag of preferred) {
    const hit = LOCALES.find((l) => primary(l.code) === primary(tag));
    if (hit) return hit.code;
  }
  return DEFAULT_LOCALE;
}
