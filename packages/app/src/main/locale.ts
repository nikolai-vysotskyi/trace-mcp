/* Language → the native layer (TRA-386).

   Same problem appearance.ts solves, same solution: the choice lives in the
   renderer's localStorage, which the main process cannot read, so it is
   mirrored to a one-line file in userData. That is what makes the FIRST
   application menu of a cold launch already be in the user's language instead
   of flashing English until a window reports in — and `Menu.setApplicationMenu`
   replaces the menu wholesale, so "fix it later" means rebuilding all of it.

   No `electron` import on purpose: the caller passes the userData directory, so
   this stays testable without a display. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_LOCALE, isLocale, type Locale } from '../shared/i18n/locales.js';

const LOCALE_FILE = 'locale';

export function readLocale(userDataDir: string): Locale {
  try {
    const raw = readFileSync(path.join(userDataDir, LOCALE_FILE), 'utf8').trim();
    return isLocale(raw) ? raw : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function writeLocale(userDataDir: string, locale: Locale): void {
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(path.join(userDataDir, LOCALE_FILE), locale, 'utf8');
  } catch {
    // An unwritable userData dir costs one cold launch in the wrong language.
    // Never worth failing a language switch over.
  }
}
