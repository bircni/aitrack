import { CACHE_READ_RATE_MULTIPLIER } from '../constants.js';
import { stripModelEffortSuffix, stripModelVersionSuffixes } from '../data/modelId.js';
import type { FallbackCollector } from './fallback.js';
import { CODEX_FAMILY_FALLBACK, CODEX_PRICING_BY_ID, CODEX_PRICING_OVERRIDES } from './tables.js';
import type { CodexPricing } from './types.js';

export type { CodexPricing };
export {
  CODEX_PRICING_BY_ID,
  CODEX_PRICING_CURRENT,
  CODEX_PRICING_HISTORICAL,
  CODEX_PRICING_OVERRIDES,
} from './tables.js';

function canonicalCodexModelId(model: string): string {
  return stripModelEffortSuffix(stripModelVersionSuffixes(model.toLowerCase()));
}

export function lookupCodexPricing(model: string, usageDate?: string): CodexPricing | undefined {
  const id = canonicalCodexModelId(model);
  if (usageDate) {
    const overrides = CODEX_PRICING_OVERRIDES[id];
    if (overrides) {
      for (const entry of overrides) {
        if (usageDate < entry.before) return entry.pricing;
      }
    }
  }
  return CODEX_PRICING_BY_ID[id];
}

export function findCodexPricing(
  model: string,
  usageDate?: string,
  fallbacks?: FallbackCollector,
): CodexPricing | undefined {
  const exact = lookupCodexPricing(model, usageDate);
  if (exact) return exact;
  const id = canonicalCodexModelId(model);
  for (const { match, pricing } of CODEX_FAMILY_FALLBACK) {
    if (!match.test(id)) {
      continue;
    }

    fallbacks?.record(id);
    return pricing;
  }
  return undefined;
}

export function estimateCodexCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  usageDate?: string,
  fallbacks?: FallbackCollector,
): number | undefined {
  const p = findCodexPricing(model, usageDate, fallbacks);
  if (!p) return undefined;
  const fresh = Math.max(0, inputTokens - cachedInputTokens);
  const cached = Math.min(cachedInputTokens, inputTokens);
  return (
    (fresh * p.inputPerMillion +
      cached * p.inputPerMillion * CACHE_READ_RATE_MULTIPLIER +
      outputTokens * p.outputPerMillion) /
    1_000_000
  );
}
