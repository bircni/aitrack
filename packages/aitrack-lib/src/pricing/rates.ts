/** Per-million-token rates for the four buckets Cursor (and Claude) bill separately. */
export interface FullModelRates {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export interface TokenRateBuckets {
  raw: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Weighted sum used by every list-price estimator. */
export function costFromRates(rates: FullModelRates, tokens: TokenRateBuckets): number {
  return (
    (tokens.raw * rates.inputPerMillion +
      tokens.output * rates.outputPerMillion +
      tokens.cacheRead * rates.cacheReadPerMillion +
      tokens.cacheWrite * rates.cacheWritePerMillion) /
    1_000_000
  );
}

export function scaleRates(rates: FullModelRates, factor: number): FullModelRates {
  return {
    inputPerMillion: rates.inputPerMillion * factor,
    outputPerMillion: rates.outputPerMillion * factor,
    cacheReadPerMillion: rates.cacheReadPerMillion * factor,
    cacheWritePerMillion: rates.cacheWritePerMillion * factor,
  };
}
