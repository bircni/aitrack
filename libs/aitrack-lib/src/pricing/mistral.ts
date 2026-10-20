import { CACHE_READ_RATE_MULTIPLIER } from '../constants.js';
import { stripModelAliasSuffix } from '../data/modelId.js';
import type { FallbackCollector } from './fallback.js';
import { currentModelPricing } from './store.js';
import type { MistralPricing } from './types.js';

// Not canonicalModelId: `-medium` and `-small` are Mistral families, not effort labels.
function mistralModelId(model: string): string {
  return stripModelAliasSuffix(model.toLowerCase());
}

export function lookupMistralPricing(model: string): MistralPricing | undefined {
  return currentModelPricing().lookupMistral(mistralModelId(model));
}

function findMistralPricing(
  model: string,
  fallbacks?: FallbackCollector,
): MistralPricing | undefined {
  const exact = lookupMistralPricing(model);
  if (exact) return exact;
  const id = mistralModelId(model);
  const fallback = currentModelPricing()
    .mistralFamilyFallbacks()
    .find(({ match }) => match.test(id));
  if (fallback) fallbacks?.record(id);
  return fallback?.pricing;
}

export function estimateMistralCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  fallbacks?: FallbackCollector,
): number | undefined {
  const p = findMistralPricing(model, fallbacks);
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
