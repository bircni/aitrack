import { CACHE_READ_RATE_MULTIPLIER } from '../constants.js';
import { canonicalModelId } from '../data/modelId.js';
import type { FallbackCollector } from './fallback.js';
import { currentModelPricing } from './store.js';
import type { CodexPricing } from './types.js';

export type { CodexPricing };

export function lookupCodexPricing(model: string, usageDate?: string): CodexPricing | undefined {
  const id = canonicalModelId(model);
  return currentModelPricing().lookupCodex(id, usageDate);
}

export function findCodexPricing(
  model: string,
  usageDate?: string,
  fallbacks?: FallbackCollector,
): CodexPricing | undefined {
  const exact = lookupCodexPricing(model, usageDate);
  if (exact) return exact;
  const id = canonicalModelId(model);
  const pricing = currentModelPricing();
  const fromCatalog = pricing.lookupCatalogCodex(id);
  if (fromCatalog) return fromCatalog;
  const fallback = pricing.codexFamilyFallbacks().find(({ match }) => match.test(id));
  if (fallback) fallbacks?.record(id);
  return fallback?.pricing;
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
