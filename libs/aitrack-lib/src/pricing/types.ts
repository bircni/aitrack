import type { FullModelRates } from './rates.js';

export interface ClaudePricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheCreatePerMillion: number;
}

export interface CodexPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Cursor-native models expose rates for all four token buckets. */
export type CursorPricing = FullModelRates;

/** Apply `pricing` for usage dates strictly before `before` (YYYY-MM-DD). */
export interface PricingOverride<P> {
  before: string;
  pricing: P;
}
