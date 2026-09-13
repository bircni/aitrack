import { CACHE_READ_RATE_MULTIPLIER } from '../constants.js';
import { lookupClaudePricing } from './claude.js';
import { lookupCodexPricing } from './codex.js';
import { costFromRates, type FullModelRates, scaleRates } from './rates.js';
import { applyCursorAlias, CURSOR_FAST_MULTIPLIERS, CURSOR_MODELS } from './tables.js';
import type { CursorPricing } from './types.js';

export { CURSOR_MODELS };
export type { CursorPricing };

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
  const cursor = CURSOR_MODELS[model];
  if (cursor) return cursor;
  const claude = lookupClaudePricing(model, usageDate);
  if (claude) return claudeToCursorRates(claude);
  const codex = lookupCodexPricing(model, usageDate);
  if (codex) return codexToCursorRates(codex);
  return undefined;
}

export function resolveCursorRates(model: string, usageDate?: string): FullModelRates | undefined {
  const aliased = applyCursorAlias(model);
  const exact = lookupExactCursorRates(aliased, usageDate);
  if (exact) return exact;

  if (!aliased.endsWith('-fast')) return undefined;
  const base = aliased.slice(0, -'-fast'.length);
  if (base === '') return undefined;
  const baseRates = lookupExactCursorRates(base, usageDate);
  const multiplier = CURSOR_FAST_MULTIPLIERS[base];
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
