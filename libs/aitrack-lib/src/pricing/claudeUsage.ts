import type { TokenCounts } from '../data/types.js';

export interface ClaudeMessageUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/** Split cache writes into the 5-minute and 1-hour buckets when the transcript does. */
function claudeCacheWriteTokens(usage: ClaudeMessageUsage): {
  fiveMinute: number;
  oneHour: number;
} {
  const fiveMinute = usage.cache_creation?.ephemeral_5m_input_tokens;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens;
  if ((fiveMinute ?? 0) + (oneHour ?? 0) > 0) {
    return { fiveMinute: fiveMinute ?? 0, oneHour: oneHour ?? 0 };
  }
  return { fiveMinute: usage.cache_creation_input_tokens ?? 0, oneHour: 0 };
}

export function claudeUsageCounts(usage: ClaudeMessageUsage): TokenCounts {
  const writes = claudeCacheWriteTokens(usage);
  const rawInputTokens = usage.input_tokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  return {
    inputTokens: rawInputTokens + cachedInputTokens + writes.fiveMinute + writes.oneHour,
    outputTokens: usage.output_tokens ?? 0,
    rawInputTokens,
    cachedInputTokens,
    cacheCreationInputTokens: writes.fiveMinute,
    ...(writes.oneHour > 0 && { cacheCreation1hInputTokens: writes.oneHour }),
  };
}
