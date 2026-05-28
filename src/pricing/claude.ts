// Per-model Claude pricing from https://platform.claude.com/docs/en/about-claude/pricing
// Cache read = 0.10x input; cache create (5min) = 1.25x input.
// Keep entries keyed by canonical model id (with `-YYYYMMDD` date suffix stripped).
// Last updated: 2026-05. Run `pnpm tsx scripts/update-pricing.ts` to check for drift.

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
  // Current generation (Opus 4.5+ all share $5/$25)
  'claude-opus-4-8': priceFromBase(5, 25),
  'claude-opus-4-7': priceFromBase(5, 25),
  'claude-opus-4-6': priceFromBase(5, 25),
  'claude-opus-4-5': priceFromBase(5, 25),
  'claude-sonnet-4-6': priceFromBase(3, 15),
  'claude-sonnet-4-5': priceFromBase(3, 15),
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
> = {};

// Family fallback for unknown future models.
const FAMILY_FALLBACK: Record<'opus' | 'sonnet' | 'haiku', ClaudePricing> = {
  opus: priceFromBase(5, 25),
  sonnet: priceFromBase(3, 15),
  haiku: priceFromBase(1, 5),
};

// Tracks ids that fell through to family fallback so callers can warn at end-of-run.
const fallbackHits = new Set<string>();
export function consumeClaudeFallbackHits(): string[] {
  const xs = [...fallbackHits].sort();
  fallbackHits.clear();
  return xs;
}

export function findClaudePricing(model: string, usageDate?: string): ClaudePricing {
  const id = model.toLowerCase().replace(/-\d{8}$/, '');
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
  for (const family of ['opus', 'haiku', 'sonnet'] as const) {
    if (id.includes(family)) {
      fallbackHits.add(id);
      return FAMILY_FALLBACK[family];
    }
  }
  fallbackHits.add(id);
  return FAMILY_FALLBACK.sonnet;
}
