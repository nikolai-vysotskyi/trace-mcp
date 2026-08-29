import { de } from './de/index.js';
import { en } from './en/index.js';
import { es } from './es/index.js';
import { fr } from './fr/index.js';
import { hi } from './hi/index.js';
import { ja } from './ja/index.js';
import { ko } from './ko/index.js';
import { ptBR } from './pt-BR/index.js';
import { ru } from './ru/index.js';
import { zh } from './zh/index.js';
import type { Locale } from '../locales.js';

/* Statically imported, not fetched: the whole point of a desktop app is that
   the first paint does not wait on anything, and here the bundle is a file on
   the user's own disk.

   Measured cost of going from four languages to ten (TRA-450): the renderer's
   main chunk went 850 KB → 1343 KB raw, 237 KB → 389 KB gzipped. That is parse
   time off local disk, not a download, and it buys the property that switching
   language is instant and cannot fail. The escape hatch, if a later count makes
   this untenable, is a dynamic import per locale with `en` kept static as the
   fallback — which costs an async boundary around startup that nothing in the
   app has today. Not worth it at ten. */
export const CATALOGS: Record<Locale, Record<string, Record<string, string>>> = {
  en,
  de,
  es,
  fr,
  hi,
  ja,
  ko,
  'pt-BR': ptBR,
  ru,
  zh,
};

export const NAMESPACES = Object.keys(en) as ReadonlyArray<keyof typeof en>;

export { de, en, es, fr, hi, ja, ko, ptBR, ru, zh };
export type { Catalog } from './en/index.js';
