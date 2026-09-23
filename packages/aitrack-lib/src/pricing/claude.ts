// Per-model Claude pricing from tables/claude.json.
// Last updated: 2026-09-23. Edit the JSON to change rates; run `pnpm run pricing:check` for drift.

import { CLAUDE_FAMILIES, canonicalizeClaudeModelId } from '../data/modelId.js';
import type { FallbackCollector } from './fallback.js';
import { costFromRates } from './rates.js';
import { CLAUDE_FAMILY_FALLBACK, CLAUDE_MODELS, CLAUDE_PRICING_OVERRIDES } from './tables.js';
import type { ClaudePricing } from './types.js';

export type { ClaudePricing };
export { CLAUDE_MODELS as CLAUDE_PRICING_BY_ID, CLAUDE_PRICING_OVERRIDES } from './tables.js';

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
  if (usageDate) {
    const overrides = CLAUDE_PRICING_OVERRIDES[id];
    if (overrides) {
      for (const entry of overrides) {
        if (usageDate < entry.before) return entry.pricing;
      }
    }
  }
  return CLAUDE_MODELS[id];
}

export function findClaudePricing(
  model: string,
  usageDate?: string,
  fallbacks?: FallbackCollector,
): ClaudePricing | undefined {
  const exact = lookupClaudePricing(model, usageDate);
  if (exact) return exact;
  const id = canonicalClaudeModelId(model);
  for (const family of CLAUDE_FAMILIES) {
    if (!id.includes(family)) {
      continue;
    }

    fallbacks?.record(id);
    return CLAUDE_FAMILY_FALLBACK[family];
  }
  // An id that names no family is not Sonnet. Guessing a price there is how a
  // missing model field turned into a confident dollar total.
  return undefined;
}

function claudeCost(
  pricing: ClaudePricing,
  tokens: { raw: number; output: number; cacheRead: number; cacheCreate: number },
): number {
  return costFromRates(
    {
      inputPerMillion: pricing.inputPerMillion,
      outputPerMillion: pricing.outputPerMillion,
      cacheReadPerMillion: pricing.cacheReadPerMillion,
      cacheWritePerMillion: pricing.cacheCreatePerMillion,
    },
    {
      raw: tokens.raw,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheCreate,
    },
  );
}

export interface ClaudeMessageUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function estimateClaudeCostUSD(
  model: string,
  usage: ClaudeMessageUsage,
  usageDate?: string,
  fallbacks?: FallbackCollector,
): number | undefined {
  const pricing = findClaudePricing(model, usageDate, fallbacks);
  if (!pricing) return undefined;
  return claudeCost(pricing, {
    raw: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreate: usage.cache_creation_input_tokens ?? 0,
  });
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
    cacheCreate: 0,
  });
}

export function claudeCountsHaveCostBreakdown(counts: {
  rawInputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}): boolean {
  return (
    counts.rawInputTokens !== undefined ||
    counts.cachedInputTokens !== undefined ||
    counts.cacheCreationInputTokens !== undefined
  );
}

export function estimateClaudeCostFromStoredCounts(
  model: string,
  counts: {
    inputTokens: number;
    outputTokens: number;
    rawInputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
  },
  usageDate?: string,
  fallbacks?: FallbackCollector,
): number | undefined {
  if (!claudeCountsHaveCostBreakdown(counts)) return undefined;
  const pricing = findClaudePricing(model, usageDate, fallbacks);
  if (!pricing) return undefined;
  const cacheRead = counts.cachedInputTokens ?? 0;
  const cacheCreate = counts.cacheCreationInputTokens ?? 0;
  return claudeCost(pricing, {
    raw: counts.rawInputTokens ?? Math.max(0, counts.inputTokens - cacheRead - cacheCreate),
    output: counts.outputTokens,
    cacheRead,
    cacheCreate,
  });
}
