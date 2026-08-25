// Per-model Claude pricing from https://platform.claude.com/docs/en/about-claude/pricing
// Cache read = 0.10x input; cache create (5min) = 1.25x input.
// Keep entries keyed by normalized family-first id (with date/latest suffixes stripped).
// Last updated: 2026-08-03. Run `pnpm tsx scripts/update-pricing.ts` to check for drift.

import { CACHE_READ_RATE_MULTIPLIER } from '../constants.js';
import { stripModelVersionSuffixes } from '../data/modelId.js';
import type { FallbackCollector } from './fallback.js';

export interface ClaudePricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheCreatePerMillion: number;
}

function priceFromBase(input: number, output: number): ClaudePricing {
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: input * CACHE_READ_RATE_MULTIPLIER,
    cacheCreatePerMillion: input * 1.25,
  };
}

export const CLAUDE_PRICING_BY_ID: Record<string, ClaudePricing> = {
  // Latest generation (Fable/Mythos tier: $10/$50)
  'claude-fable-5': priceFromBase(10, 50),
  'claude-mythos-5': priceFromBase(10, 50),
  // Current generation (Opus 4.5+ and Sonnet/Haiku 4.5+ tier)
  'claude-opus-5': priceFromBase(5, 25),
  'claude-opus-4-8': priceFromBase(5, 25),
  'claude-opus-4-7': priceFromBase(5, 25),
  'claude-opus-4-6': priceFromBase(5, 25),
  'claude-opus-4-5': priceFromBase(5, 25),
  'claude-sonnet-4-6': priceFromBase(3, 15),
  'claude-sonnet-4-5': priceFromBase(3, 15),
  'claude-sonnet-5': priceFromBase(3, 15),
  'claude-haiku-4-5': priceFromBase(1, 5),
  // Older / deprecated
  'claude-opus-4-1': priceFromBase(15, 75),
  'claude-opus-4-0': priceFromBase(15, 75),
  'claude-opus-4': priceFromBase(15, 75),
  'claude-sonnet-4-0': priceFromBase(3, 15),
  'claude-sonnet-4': priceFromBase(3, 15),
  'claude-haiku-3-5': priceFromBase(0.8, 4),
  // Claude 3 generation. Listed explicitly because the family fallback prices
  // them at the modern tier, which is 3x too low for opus and 4x too high for
  // haiku, and the wrong figure gets persisted as costUSD.
  'claude-opus-3': priceFromBase(15, 75),
  'claude-sonnet-3-7': priceFromBase(3, 15),
  'claude-sonnet-3-5': priceFromBase(3, 15),
  'claude-sonnet-3': priceFromBase(3, 15),
  'claude-haiku-3': priceFromBase(0.25, 1.25),
};

// Historical pricing overrides. Each entry means "for usage dates strictly
// BEFORE `before`, this model was priced as `pricing` instead of the entry
// in CLAUDE_PRICING_BY_ID". Sort each list ascending by `before`.
//
// Anthropic normally ships a new model id at a new tier rather than re-pricing
// an existing one, so this table stays small. It exists for the exception:
// claude-sonnet-5 launched at introductory rates and moved to the standard
// tier later, and without the entry every day of sonnet-5 usage recorded
// before that date would be silently re-costed at the higher rate.
export const CLAUDE_PRICING_OVERRIDES: Record<
  string,
  Array<{ before: string; pricing: ClaudePricing }>
> = {
  // Introductory pricing through 2026-08-31; standard tier from 2026-09-01.
  'claude-sonnet-5': [{ before: '2026-09-01', pricing: priceFromBase(2, 10) }],
};

// Family fallback for unknown future models.
const FAMILY_FALLBACK: Record<'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku', ClaudePricing> = {
  fable: priceFromBase(10, 50),
  mythos: priceFromBase(10, 50),
  opus: priceFromBase(5, 25),
  sonnet: priceFromBase(3, 15),
  haiku: priceFromBase(1, 5),
};

// Called once per assistant entry while reading the JSONL corpus, which holds
// only a handful of distinct model strings, so the lowercase plus two regexes
// are worth caching.
const canonicalIdCache = new Map<string, string>();

function canonicalClaudeModelId(model: string): string {
  const cached = canonicalIdCache.get(model);
  if (cached !== undefined) return cached;

  const id = stripModelVersionSuffixes(model.toLowerCase());
  const legacy = /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)$/.exec(id);
  const [, major, minor, family] = legacy ?? [];
  const canonical =
    legacy && major && family ? `claude-${family}-${major}${minor ? `-${minor}` : ''}` : id;

  canonicalIdCache.set(model, canonical);
  return canonical;
}

export function findClaudePricing(
  model: string,
  usageDate?: string,
  fallbacks?: FallbackCollector,
): ClaudePricing {
  const id = canonicalClaudeModelId(model);
  if (usageDate) {
    const overrides = CLAUDE_PRICING_OVERRIDES[id];
    if (overrides) {
      for (const entry of overrides) {
        if (usageDate < entry.before) return entry.pricing;
      }
    }
  }
  const exact = CLAUDE_PRICING_BY_ID[id];
  if (exact) return exact;
  for (const family of ['fable', 'mythos', 'opus', 'haiku', 'sonnet'] as const) {
    if (!id.includes(family)) {
      continue;
    }

    fallbacks?.record(id);
    return FAMILY_FALLBACK[family];
  }
  // Unrecognized entirely — still a guess, so it counts as a fallback hit.
  fallbacks?.record(id);
  return FAMILY_FALLBACK.sonnet;
}

/**
 * The one weighted-sum formula behind all three estimators below, which
 * previously each spelled out the same `(a*in + b*out + …)/1_000_000`.
 */
function claudeCost(
  pricing: ClaudePricing,
  tokens: { raw: number; output: number; cacheRead: number; cacheCreate: number },
): number {
  return (
    (tokens.raw * pricing.inputPerMillion +
      tokens.output * pricing.outputPerMillion +
      tokens.cacheRead * pricing.cacheReadPerMillion +
      tokens.cacheCreate * pricing.cacheCreatePerMillion) /
    1_000_000
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
): number {
  return claudeCost(findClaudePricing(model, usageDate, fallbacks), {
    raw: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreate: usage.cache_creation_input_tokens ?? 0,
  });
}

// Backfill estimator for synced rows that lack a costUSD value (older data).
// The cache vs raw-input split has already been collapsed into a single
// inputTokens number, so we apply full input pricing — an upper bound.
export function estimateClaudeCostFromAggregateTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  usageDate?: string,
  fallbacks?: FallbackCollector,
): number {
  return claudeCost(findClaudePricing(model, usageDate, fallbacks), {
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
  const cacheRead = counts.cachedInputTokens ?? 0;
  const cacheCreate = counts.cacheCreationInputTokens ?? 0;
  return claudeCost(findClaudePricing(model, usageDate, fallbacks), {
    raw: counts.rawInputTokens ?? Math.max(0, counts.inputTokens - cacheRead - cacheCreate),
    output: counts.outputTokens,
    cacheRead,
    cacheCreate,
  });
}
