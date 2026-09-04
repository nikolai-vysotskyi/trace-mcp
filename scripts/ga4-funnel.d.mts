/** One GA4 `runReport` row, reduced to what the funnel reads. */
export interface FunnelRow {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}

export interface Activation {
  buckets: { '0': number; '1': number; '2-5': number; '6+': number };
  unknown: number;
  activated: number;
  not_activated: number;
  activated_pct: number | null;
}

/** Bucket `customEvent:repos_indexed` rows into the activation split. */
export function activation(rows: FunnelRow[] | undefined | null): Activation;

/** Percentage, or null when the denominator is missing. */
export function share(part: number, whole: number): number | null;

export interface ClientReporting {
  fix_version: string;
  at_or_above: number;
  below: number;
  unknown: number;
  pct: number | null;
  readable: boolean | null;
}

/** First version whose ping reports its client correctly. */
export const CLIENT_FIX_VERSION: string;

/** Share of `customEvent:version` rows able to report a client (TRA-748). */
export function clientReporting(
  rows: FunnelRow[] | undefined | null,
  floor?: string,
): ClientReporting;

/** Days of history the 28-day window needs before `month` covers a month. */
export const MONTH_WINDOW_DAYS: number;

/** Inclusive days of data from GA4's `YYYYMMDD` first-ping date (TRA-843). */
export function daysObserved(firstDate: string | undefined | null, today?: Date): number | null;

/** Whether the property has enough history for a 28-day window to be one. */
export function monthWindowFull(observed: number | null): boolean;

/** DAU/MAU, or null until the month window covers a month (TRA-843). */
export function retention(day: number, month: number, windowFull: boolean): number | null;
