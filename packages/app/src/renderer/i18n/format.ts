/* Locale-aware formatting (TRA-379).

   These are thin wrappers over Intl, which is already in every runtime we ship
   to — a formatting library would be a second implementation of what the
   platform does correctly, including the cases nobody remembers (Russian says
   "2 часа назад" but "5 часов назад"; a German date is 29.8.2026).

   The app had three hand-written "N ago" helpers when this landed — formatAgo
   in update-check.ts, relativeTime in ProjectOverview and describeAge in the
   KPI baseline — each with its own thresholds. `relativeTime` here is the one
   they collapse into as their surfaces are extracted; `style` is why they can. */

import { currentLocale } from './index.js';

/* Intl constructors are the expensive part; the format calls are not. Keyed by
   locale, so a language switch builds new formatters rather than being served
   the previous language's. */
const cache = new Map<string, unknown>();

function memo<T>(key: string, make: () => T): T {
  let hit = cache.get(key) as T | undefined;
  if (hit === undefined) {
    hit = make();
    cache.set(key, hit);
  }
  return hit;
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  const locale = currentLocale();
  return memo(`n:${locale}:${options ? JSON.stringify(options) : ''}`, () =>
    new Intl.NumberFormat(locale, options),
  ).format(value);
}

export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  const locale = currentLocale();
  const opts: Intl.DateTimeFormatOptions = options ?? { dateStyle: 'medium' };
  return memo(`d:${locale}:${JSON.stringify(opts)}`, () =>
    new Intl.DateTimeFormat(locale, opts),
  ).format(value);
}

/**
 * "the index summary and the quality scan" — one sentence naming several
 * things, in the active language. `conjunction`, not `unit`: the list is prose
 * inside a sentence, so English wants the "and" and Japanese wants "、".
 */
export function formatList(parts: string[]): string {
  const locale = currentLocale();
  return memo(`l:${locale}`, () => new Intl.ListFormat(locale, { type: 'conjunction' })).format(
    parts,
  );
}

/* Read top-down as "is it under a minute, under an hour…" — the same order the
   three hand-written helpers use, which is how a reader checks them. */
const UNITS: ReadonlyArray<
  [limitSeconds: number, perUnit: number, unit: Intl.RelativeTimeFormatUnit]
> = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86400, 3600, 'hour'],
  [Infinity, 86400, 'day'],
];

/**
 * "2 hours ago" (`long`) or "2 hr. ago" (`short`), in the active language.
 *
 * Intl's third style, `narrow`, is deliberately not offered: it gives English
 * the "2h ago" this app used to hand-roll, but Russian gets "-2 ч" — a minus
 * sign where the word "назад" belongs. `short` is the compact style that
 * survives the language switch.
 *
 * Past only, which is all the app has: a timestamp in the future is clock skew
 * and clamps to "now" rather than rendering "in 3 seconds".
 */
export function relativeTime(
  ts: number,
  now: number = Date.now(),
  style: 'long' | 'short' = 'long',
): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  const [, perUnit, unit] = UNITS.find(([limit]) => seconds < limit)!;
  const locale = currentLocale();
  const fmt = memo(
    `r:${locale}:${style}`,
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style }),
  );
  return fmt.format(-Math.floor(seconds / perUnit), unit);
}
