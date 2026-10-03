import type { ClaudeFamily } from '../data/modelId.js';
import { currentModelPricing } from './store.js';
import type { ClaudePricing, CodexPricing, CursorPricing, PricingOverride } from './types.js';

export type { PricingOverride };

/** Keep mutable exports attached to the active snapshot, including merged table views. */
function liveTables<T extends object>(getTables: () => [T, ...T[]], target = {} as T): T {
  const tableFor = (key: PropertyKey): T => {
    const tables = getTables();
    return tables.find((table) => Object.hasOwn(table, key)) ?? tables[0];
  };
  return new Proxy<T>(target, {
    get: (_, key): unknown => Reflect.get(tableFor(key), key),
    set: (_, key, value: unknown) => Reflect.set(tableFor(key), key, value),
    deleteProperty: (_, key) => getTables().every((table) => Reflect.deleteProperty(table, key)),
    has: (_, key) => getTables().some((table) => Reflect.has(table, key)),
    ownKeys: () => [...new Set(getTables().flatMap((table) => Reflect.ownKeys(table)))],
    getOwnPropertyDescriptor: (_, key) => Reflect.getOwnPropertyDescriptor(tableFor(key), key),
    // Fixed descriptors cannot follow replacement snapshots.
    defineProperty: () => false,
    preventExtensions: () => false,
  });
}

export const CLAUDE_MODELS: Record<string, ClaudePricing> = liveTables(() => [
  currentModelPricing().pricingTable('claude').models,
]);
export const CLAUDE_FAMILY_FALLBACK: Record<ClaudeFamily, ClaudePricing> = liveTables(() => [
  currentModelPricing().pricingTable('claude').familyFallback,
]);
export const CLAUDE_PRICING_OVERRIDES: Record<
  string,
  Array<PricingOverride<ClaudePricing>>
> = liveTables(() => [currentModelPricing().pricingOverrides('claude')]);

export const CODEX_PRICING_CURRENT: Record<string, CodexPricing> = liveTables(() => [
  currentModelPricing().pricingTable('codex').current,
]);
export const CODEX_PRICING_HISTORICAL: Record<string, CodexPricing> = liveTables(() => [
  currentModelPricing().pricingTable('codex').historical,
]);
export const CODEX_PRICING_BY_ID: Record<string, CodexPricing> = liveTables(() => {
  const { current, historical } = currentModelPricing().pricingTable('codex');
  return [current, historical];
});
export const CODEX_PRICING_OVERRIDES: Record<
  string,
  Array<PricingOverride<CodexPricing>>
> = liveTables(() => [currentModelPricing().pricingOverrides('codex')]);
export const CODEX_FAMILY_FALLBACK: Array<{ match: RegExp; pricing: CodexPricing }> = liveTables(
  () => [currentModelPricing().codexFamilyFallbacks()],
  [],
);

export const CURSOR_MODELS: Record<string, CursorPricing> = liveTables(() => [
  currentModelPricing().pricingTable('cursor').models,
]);
export const CURSOR_FAST_MULTIPLIERS: Record<string, number> = liveTables(() => [
  currentModelPricing().pricingTable('cursor').fastMultipliers,
]);

/** First matching alias, or the original slug. Uses the live pricing pack. */
export function applyCursorAlias(model: string): string {
  return currentModelPricing().applyCursorAlias(model);
}
