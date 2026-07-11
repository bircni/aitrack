// Per-model OpenAI (Codex) pricing.
// Sources:
//   https://developers.openai.com/api/docs/pricing
//   https://developers.openai.com/codex/pricing
//   https://openrouter.ai/openai/gpt-5.1-codex
// Codex sessions report aggregate input/output tokens plus a cached-input subset,
// which is billed at 10% of the base input rate.
// Last updated: 2026-05.

export interface CodexPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

// Models currently listed on developers.openai.com/api/docs/pricing.
// Verified by `pnpm run pricing:check`.
export const CODEX_PRICING_CURRENT: Record<string, CodexPricing> = {
  'gpt-5.6-sol': { inputPerMillion: 5, outputPerMillion: 30 },
  'gpt-5.6-terra': { inputPerMillion: 2.5, outputPerMillion: 15 },
  'gpt-5.6-luna': { inputPerMillion: 1, outputPerMillion: 6 },
  'gpt-5.5': { inputPerMillion: 5, outputPerMillion: 30 },
  'gpt-5.4': { inputPerMillion: 2.5, outputPerMillion: 15 },
  'gpt-5.4-mini': { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  'gpt-5.4-nano': { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  'gpt-5.3-codex': { inputPerMillion: 1.75, outputPerMillion: 14 },
  'gpt-5-codex': { inputPerMillion: 1.25, outputPerMillion: 10 },
};

// Models we've seen in synced session data but that OpenAI no longer lists
// publicly. Kept here so historical sessions still cost-resolve. Not checked
// by the drift script.
export const CODEX_PRICING_HISTORICAL: Record<string, CodexPricing> = {
  'gpt-5.2-codex': { inputPerMillion: 1.75, outputPerMillion: 14 },
  'gpt-5.1-codex': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5.1-codex-max': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5.1-codex-mini': { inputPerMillion: 0.25, outputPerMillion: 2 },
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5.1': { inputPerMillion: 1.25, outputPerMillion: 10 },
};

export const CODEX_PRICING_BY_ID: Record<string, CodexPricing> = {
  ...CODEX_PRICING_CURRENT,
  ...CODEX_PRICING_HISTORICAL,
};

// Historical pricing overrides. Same shape + semantics as Claude's overrides.
export const CODEX_PRICING_OVERRIDES: Record<
  string,
  Array<{ before: string; pricing: CodexPricing }>
> = {};

// Fallback by family slug — keeps cost reasonable for unknown future model ids.
const FAMILY_FALLBACK: Array<{ match: RegExp; pricing: CodexPricing }> = [
  { match: /-nano$/, pricing: { inputPerMillion: 0.2, outputPerMillion: 1.25 } },
  { match: /-mini$/, pricing: { inputPerMillion: 0.25, outputPerMillion: 2 } },
  { match: /-codex(-max)?$/, pricing: { inputPerMillion: 1.25, outputPerMillion: 10 } },
];

const fallbackHits = new Set<string>();
export function consumeCodexFallbackHits(): string[] {
  const xs = [...fallbackHits].sort((a, b) => a.localeCompare(b));
  fallbackHits.clear();
  return xs;
}

export function findCodexPricing(model: string, usageDate?: string): CodexPricing | undefined {
  const id = model.toLowerCase();
  if (usageDate) {
    const overrides = CODEX_PRICING_OVERRIDES[id];
    if (overrides) {
      for (const entry of overrides) {
        if (usageDate < entry.before) return entry.pricing;
      }
    }
  }
  const exact = CODEX_PRICING_BY_ID[id];
  if (exact) return exact;
  for (const { match, pricing } of FAMILY_FALLBACK) {
    if (!match.test(id)) {
      continue;
    }

    fallbackHits.add(id);
    return pricing;
  }
  if (id.startsWith('gpt-5')) {
    fallbackHits.add(id);
    return { inputPerMillion: 1.25, outputPerMillion: 10 };
  }
  return undefined;
}

// OpenAI's automatic prompt caching bills cache hits at 10% of base input.
// `inputTokens` here is the FULL prompt count (includes cached); `cachedInputTokens`
// is the subset that hit the cache (defaults to 0).
export function estimateCodexCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  usageDate?: string,
): number | undefined {
  const p = findCodexPricing(model, usageDate);
  if (!p) return undefined;
  const fresh = Math.max(0, inputTokens - cachedInputTokens);
  const cached = Math.min(cachedInputTokens, inputTokens);
  return (
    (fresh * p.inputPerMillion +
      cached * p.inputPerMillion * 0.1 +
      outputTokens * p.outputPerMillion) /
    1_000_000
  );
}
