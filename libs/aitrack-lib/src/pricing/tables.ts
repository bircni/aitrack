import type { ClaudeFamily } from '../data/modelId.js';
import { currentModelPricing } from './store.js';
import claudeTable from './tables/claude.json' with { type: 'json' };
import codexTable from './tables/codex.json' with { type: 'json' };
import cursorTable from './tables/cursor.json' with { type: 'json' };
import type { ClaudePricing, CodexPricing, CursorPricing, PricingOverride } from './types.js';

export type { PricingOverride };

/** Keep mutable override exports attached to the active pricing snapshot. */
function liveOverrides<P>(getRecord: () => Record<string, P>): Record<string, P> {
  return new Proxy<Record<string, P>>(
    {},
    {
      get: (_, key): unknown => Reflect.get(getRecord(), key),
      set: (_, key, value: P) => Reflect.set(getRecord(), key, value),
      deleteProperty: (_, key) => Reflect.deleteProperty(getRecord(), key),
      has: (_, key) => Reflect.has(getRecord(), key),
      ownKeys: () => Reflect.ownKeys(getRecord()),
      getOwnPropertyDescriptor: (_, key) => Reflect.getOwnPropertyDescriptor(getRecord(), key),
      // Fixed descriptors cannot follow replacement snapshots.
      defineProperty: () => false,
      preventExtensions: () => false,
    },
  );
}

export const CLAUDE_MODELS: Record<string, ClaudePricing> = claudeTable.models;
export const CLAUDE_FAMILY_FALLBACK: Record<ClaudeFamily, ClaudePricing> =
  claudeTable.familyFallback;
export const CLAUDE_PRICING_OVERRIDES: Record<
  string,
  Array<PricingOverride<ClaudePricing>>
> = liveOverrides(() => currentModelPricing().pricingOverrides('claude'));

export const CODEX_PRICING_CURRENT: Record<string, CodexPricing> = codexTable.current;
export const CODEX_PRICING_HISTORICAL: Record<string, CodexPricing> = codexTable.historical;
export const CODEX_PRICING_BY_ID: Record<string, CodexPricing> = {
  ...codexTable.current,
  ...codexTable.historical,
};
export const CODEX_PRICING_OVERRIDES: Record<
  string,
  Array<PricingOverride<CodexPricing>>
> = liveOverrides(() => currentModelPricing().pricingOverrides('codex'));
export const CODEX_FAMILY_FALLBACK: Array<{ match: RegExp; pricing: CodexPricing }> =
  codexTable.familyFallback.map((entry) => ({
    match: new RegExp(entry.match, 'u'),
    pricing: { inputPerMillion: entry.inputPerMillion, outputPerMillion: entry.outputPerMillion },
  }));

export const CURSOR_MODELS: Record<string, CursorPricing> = cursorTable.models;
export const CURSOR_FAST_MULTIPLIERS: Record<string, number> = cursorTable.fastMultipliers;

/** First matching alias, or the original slug. Uses the live pricing pack. */
export function applyCursorAlias(model: string): string {
  return currentModelPricing().applyCursorAlias(model);
}
