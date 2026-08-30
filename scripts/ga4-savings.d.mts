/** Model whose published input price backs the dollar figure. */
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
};

/** Dollars for a token count, at `PRICE_PER_TOKEN`. */
export function usd(tokens: number): number;
