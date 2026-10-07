import { CACHE_READ_RATE_MULTIPLIER } from '../constants.js';
import { lookupClaudePricing } from './claude.js';
import { lookupCodexPricing } from './codex.js';
import { costFromRates, type FullModelRates, scaleRates } from './rates.js';
import { currentModelPricing } from './store.js';

function claudeToCursorRates(pricing: {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheCreatePerMillion: number;
}): FullModelRates {
  return {
    inputPerMillion: pricing.inputPerMillion,
    outputPerMillion: pricing.outputPerMillion,
    cacheReadPerMillion: pricing.cacheReadPerMillion,
    cacheWritePerMillion: pricing.cacheCreatePerMillion,
  };
}

function codexToCursorRates(pricing: {
  inputPerMillion: number;
  outputPerMillion: number;
}): FullModelRates {
  return {
    inputPerMillion: pricing.inputPerMillion,
    outputPerMillion: pricing.outputPerMillion,
    cacheReadPerMillion: pricing.inputPerMillion * CACHE_READ_RATE_MULTIPLIER,
    cacheWritePerMillion: pricing.inputPerMillion,
  };
}

function lookupExactCursorRates(model: string, usageDate?: string): FullModelRates | undefined {
  const pricing = currentModelPricing();
  const cursor = pricing.lookupCursorNative(model);
  if (cursor) return cursor;
  const claude = lookupClaudePricing(model, usageDate);
  if (claude) return claudeToCursorRates(claude);
  const codex = lookupCodexPricing(model, usageDate);
  if (codex) return codexToCursorRates(codex);
  // Do not fall through to public catalogs here: Cursor CSV slugs that aren't
  // in the supplement (or Claude/Codex tables) stay unpriced on purpose.
  return undefined;
}

export function resolveCursorRates(model: string, usageDate?: string): FullModelRates | undefined {
  const pricing = currentModelPricing();
  const aliased = pricing.applyCursorAlias(model);
  const exact = lookupExactCursorRates(aliased, usageDate);
  if (exact) return exact;

  if (!aliased.endsWith('-fast')) return undefined;
  const base = aliased.slice(0, -'-fast'.length);
  if (base === '') return undefined;
  const baseRates = lookupExactCursorRates(base, usageDate);
  const multiplier = pricing.cursorFastMultiplier(base);
  if (!baseRates || multiplier === undefined) return undefined;
  return scaleRates(baseRates, multiplier);
}

export function estimateCursorCostUSD(
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
  const rates = resolveCursorRates(model, usageDate);
  if (!rates) return undefined;
  const cacheRead = counts.cachedInputTokens ?? 0;
  const cacheWrite = counts.cacheCreationInputTokens ?? 0;
  const raw = counts.rawInputTokens ?? Math.max(0, counts.inputTokens - cacheRead - cacheWrite);
  return costFromRates(rates, { raw, output: counts.outputTokens, cacheRead, cacheWrite });
}
