import { TOKEN_BREAKDOWN_FIELDS } from '../constants.js';
import { CLAUDE_FAMILIES, canonicalizeClaudeModelId } from '../data/modelId.js';
import type { TokenCounts } from '../data/types.js';
import type { FallbackCollector } from './fallback.js';
import {
  costFromRates,
  type FullModelRates,
  type TokenRateBuckets,
  tokenRateBuckets,
} from './rates.js';
import { currentModelPricing } from './store.js';
import type { ClaudePricing } from './types.js';

export type { ClaudePricing };

const canonicalIdCache = new Map<string, string>();

function canonicalClaudeModelId(model: string): string {
  const cached = canonicalIdCache.get(model);
  if (cached !== undefined) return cached;

  const canonical = canonicalizeClaudeModelId(model);
  canonicalIdCache.set(model, canonical);
  return canonical;
}

export function lookupClaudePricing(model: string, usageDate?: string): ClaudePricing | undefined {
  const id = canonicalClaudeModelId(model);
  return currentModelPricing().lookupClaude(id, usageDate);
}

export function findClaudePricing(
  model: string,
  usageDate?: string,
  fallbacks?: FallbackCollector,
): ClaudePricing | undefined {
  const exact = lookupClaudePricing(model, usageDate);
  if (exact) return exact;
  const id = canonicalClaudeModelId(model);
  const pricing = currentModelPricing();
  const fromCatalog = pricing.lookupCatalogClaude(id);
  if (fromCatalog) return fromCatalog;
  // An id that names no family stays unpriced rather than guessed as Sonnet.
  const family = CLAUDE_FAMILIES.find((name) => id.includes(name));
  if (family === undefined) return undefined;
  fallbacks?.record(id);
  return pricing.claudeFamilyFallback(family);
}

export function claudeRates(pricing: ClaudePricing): FullModelRates {
  return {
    inputPerMillion: pricing.inputPerMillion,
    outputPerMillion: pricing.outputPerMillion,
    cacheReadPerMillion: pricing.cacheReadPerMillion,
    cacheWritePerMillion: pricing.cacheCreatePerMillion,
  };
}

/** 1-hour writes cost twice the base input rate, even for models whose cache hits are not 0.1×. */
function claudeCost(pricing: ClaudePricing, tokens: TokenRateBuckets, oneHourWrites = 0): number {
  return (
    costFromRates(claudeRates(pricing), tokens) +
    (oneHourWrites * pricing.inputPerMillion * 2) / 1_000_000
  );
}

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

export function estimateClaudeCostFromAggregateTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  usageDate?: string,
  fallbacks?: FallbackCollector,
): number | undefined {
  const pricing = findClaudePricing(model, usageDate, fallbacks);
  if (!pricing) return undefined;
  return claudeCost(pricing, {
    raw: inputTokens,
    output: outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
  });
}

function claudeCountsHaveCostBreakdown(
  counts: Pick<TokenCounts, (typeof TOKEN_BREAKDOWN_FIELDS)[number]>,
): boolean {
  return TOKEN_BREAKDOWN_FIELDS.some((field) => counts[field] !== undefined);
}

export function estimateClaudeCostFromStoredCounts(
  model: string,
  counts: TokenCounts,
  usageDate?: string,
  fallbacks?: FallbackCollector,
): number | undefined {
  if (!claudeCountsHaveCostBreakdown(counts)) return undefined;
  const pricing = findClaudePricing(model, usageDate, fallbacks);
  if (!pricing) return undefined;
  return claudeCost(pricing, tokenRateBuckets(counts), counts.cacheCreation1hInputTokens);
}
