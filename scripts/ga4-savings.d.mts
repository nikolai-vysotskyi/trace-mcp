/** Below this many days `sanitizedTokens` returns the raw sum, unsanitized. */
export const MIN_DAYS_FOR_TRIM: number;

/** `raw / tokens` above which the snapshot warns that the counter is inflated. */
export const INFLATION_RATIO: number;

/** Cheapest tracked model, whose input price floors the dollar figure. */
export const PRICE_MODEL: string;

/** That model's input price, per token. */
export const PRICE_PER_TOKEN: number;

/** One day of the `tokens_saved` series. */
export interface SavingsDay {
  tokens: number;
  users: number;
}

/** Sum a daily series with inflated days capped to the median per-user rate. */
export function sanitizedTokens(days: SavingsDay[]): {
  tokens: number;
  raw: number;
  days: number;
  capped_days: number;
  raw_ratio: number | null;
  inflation_suspected: boolean;
};

/** Dollars for a token count, at `PRICE_PER_TOKEN`. */
export function usd(tokens: number): number;
