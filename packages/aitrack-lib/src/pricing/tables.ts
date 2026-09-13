import type { ClaudeFamily } from '../data/modelId.js';
import claudeTable from './tables/claude.json' with { type: 'json' };
import codexTable from './tables/codex.json' with { type: 'json' };
import cursorTable from './tables/cursor.json' with { type: 'json' };
import type { ClaudePricing, CodexPricing, CursorPricing } from './types.js';

export interface PricingOverride<P> {
  before: string;
  pricing: P;
}

interface CursorAliasRule {
  pattern: string;
  canonical: string;
}

interface CompiledAlias {
  pattern: RegExp;
  canonical: string;
}

function compilePattern(pattern: string): RegExp {
  // Swift-style (?i) prefix — JS needs the i flag instead.
  return pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'iu') : new RegExp(pattern, 'u');
}

export const CLAUDE_MODELS: Record<string, ClaudePricing> = claudeTable.models;
export const CLAUDE_FAMILY_FALLBACK: Record<ClaudeFamily, ClaudePricing> =
  claudeTable.familyFallback;
export const CLAUDE_PRICING_OVERRIDES: Record<
  string,
  Array<PricingOverride<ClaudePricing>>
> = structuredClone(claudeTable.overrides);

export const CODEX_PRICING_CURRENT: Record<string, CodexPricing> = codexTable.current;
export const CODEX_PRICING_HISTORICAL: Record<string, CodexPricing> = codexTable.historical;
export const CODEX_PRICING_BY_ID: Record<string, CodexPricing> = {
  ...codexTable.current,
  ...codexTable.historical,
};
export const CODEX_PRICING_OVERRIDES: Record<
  string,
  Array<PricingOverride<CodexPricing>>
> = structuredClone(codexTable.overrides);
export const CODEX_FAMILY_FALLBACK: Array<{ match: RegExp; pricing: CodexPricing }> =
  codexTable.familyFallback.map((entry) => ({
    match: new RegExp(entry.match, 'u'),
    pricing: { inputPerMillion: entry.inputPerMillion, outputPerMillion: entry.outputPerMillion },
  }));

export const CURSOR_MODELS: Record<string, CursorPricing> = cursorTable.models;
export const CURSOR_FAST_MULTIPLIERS: Record<string, number> = cursorTable.fastMultipliers;

const CURSOR_ALIASES: CompiledAlias[] = cursorTable.aliases.map((rule: CursorAliasRule) => ({
  pattern: compilePattern(rule.pattern),
  canonical: rule.canonical,
}));

/** First matching alias, or the original slug. */
export function applyCursorAlias(model: string): string {
  for (const rule of CURSOR_ALIASES) {
    if (rule.pattern.test(model)) return rule.canonical;
  }
  return model;
}
