import type { TokenCounts } from '../data/types.js';

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

/** Raw input is inferred from the total when a stored row has no explicit split. */
export function tokenRateBuckets(counts: TokenCounts): TokenRateBuckets {
  const cacheRead = counts.cachedInputTokens ?? 0;
  const cacheWrite = counts.cacheCreationInputTokens ?? 0;
  const oneHourWrites = counts.cacheCreation1hInputTokens ?? 0;
  return {
    raw:
      counts.rawInputTokens ??
      Math.max(0, counts.inputTokens - cacheRead - cacheWrite - oneHourWrites),
    output: counts.outputTokens,
    cacheRead,
    cacheWrite,
  };
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
