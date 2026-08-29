import { en } from './en/index.js';
import { es } from './es/index.js';
import { ru } from './ru/index.js';
import { zh } from './zh/index.js';
import type { Locale } from '../locales.js';

/* Statically imported, not fetched: the whole point of a desktop app is that
   the first paint does not wait on a network round trip, and four languages of
   UI strings are smaller than one of the icons we already ship. Revisit if the
   catalogue ever outgrows that claim. */
export const CATALOGS: Record<Locale, Record<string, Record<string, string>>> = { en, es, ru, zh };

export const NAMESPACES = Object.keys(en) as ReadonlyArray<keyof typeof en>;

export { en, es, ru, zh };
export type { Catalog } from './en/index.js';
