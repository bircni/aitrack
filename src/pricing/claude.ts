// Per-model Claude pricing from https://platform.claude.com/docs/en/about-claude/pricing
// Cache read = 0.10x input; cache create (5min) = 1.25x input.
// Keep entries keyed by normalized family-first id (with date/latest suffixes stripped).
// Last updated: 2026-07. Run `pnpm tsx scripts/update-pricing.ts` to check for drift.

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
    cacheReadPerMillion: input * 0.1,
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
};

// Historical pricing overrides. Each entry means "for usage dates strictly
// BEFORE `before`, this model was priced as `pricing` instead of the entry
// in CLAUDE_PRICING_BY_ID". Sort each list ascending by `before`.
// Empty today because Anthropic has never re-priced an existing model id —
// they ship a new id at the new tier instead. Kept here so a future repricing
// doesn't silently retroactively re-cost old data.
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

// Tracks ids that fell through to family fallback so callers can warn at end-of-run.
const fallbackHits = new Set<string>();
export function consumeClaudeFallbackHits(): string[] {
  const xs = [...fallbackHits].sort((a, b) => a.localeCompare(b));
  fallbackHits.clear();
  return xs;
}

function canonicalClaudeModelId(model: string): string {
  const id = model.toLowerCase().replace(/-(?:latest|\d{8})$/, '');
  const legacy = /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)$/.exec(id);
  if (!legacy) return id;
  const [, major, minor, family] = legacy;
  if (!major || !family) return id;
  return `claude-${family}-${major}${minor ? `-${minor}` : ''}`;
}

export function findClaudePricing(model: string, usageDate?: string): ClaudePricing {
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

    fallbackHits.add(id);
    return FAMILY_FALLBACK[family];
  }
  fallbackHits.add(id);
  return FAMILY_FALLBACK.sonnet;
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
): number {
  const pricing = findClaudePricing(model, usageDate);
  return (
    ((usage.input_tokens ?? 0) * pricing.inputPerMillion +
      (usage.output_tokens ?? 0) * pricing.outputPerMillion +
      (usage.cache_read_input_tokens ?? 0) * pricing.cacheReadPerMillion +
      (usage.cache_creation_input_tokens ?? 0) * pricing.cacheCreatePerMillion) /
    1_000_000
  );
}

// Backfill estimator for synced rows that lack a costUSD value (older data).
// The cache vs raw-input split has already been collapsed into a single
// inputTokens number, so we apply full input pricing — an upper bound.
export function estimateClaudeCostFromAggregateTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  usageDate?: string,
): number {
  const pricing = findClaudePricing(model, usageDate);
  return (
    (inputTokens * pricing.inputPerMillion + outputTokens * pricing.outputPerMillion) / 1_000_000
  );
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
): number | undefined {
  if (!claudeCountsHaveCostBreakdown(counts)) return undefined;
  const pricing = findClaudePricing(model, usageDate);
  const cacheRead = counts.cachedInputTokens ?? 0;
  const cacheCreate = counts.cacheCreationInputTokens ?? 0;
  const raw = counts.rawInputTokens ?? Math.max(0, counts.inputTokens - cacheRead - cacheCreate);
  return (
    (raw * pricing.inputPerMillion +
      counts.outputTokens * pricing.outputPerMillion +
      cacheRead * pricing.cacheReadPerMillion +
      cacheCreate * pricing.cacheCreatePerMillion) /
    1_000_000
  );
}
