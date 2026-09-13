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
export interface CursorPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}
