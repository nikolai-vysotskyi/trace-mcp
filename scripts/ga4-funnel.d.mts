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
