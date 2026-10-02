import { CACHE_READ_RATE_MULTIPLIER } from '../constants.js';
import { CLAUDE_FAMILIES, type ClaudeFamily } from '../data/modelId.js';
import {
  catalogFromCompact,
  findCatalogRates,
  type ModelRates,
  type PricingCatalog,
} from './codecs.js';
import type { PricingSupplement } from './packMeta.js';
import type { ClaudePricing, CodexPricing, CursorPricing, PricingOverride } from './types.js';

export interface ResolvedModelRates {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
  source: 'supplement' | 'family_fallback' | 'fast_multiplier';
}

interface CompiledAlias {
  pattern: RegExp;
  canonical: string;
}

function compilePattern(pattern: string): RegExp {
  return pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'iu') : new RegExp(pattern, 'u');
}

function pickOverride<P>(
  overrides: Record<string, Array<PricingOverride<P>>> | undefined,
  id: string,
  usageDate: string | undefined,
): P | undefined {
  if (!usageDate || !overrides) return undefined;
  const entries = overrides[id];
  if (!entries) return undefined;
  for (const entry of entries) {
    if (usageDate < entry.before) return entry.pricing;
  }
  return undefined;
}

function cursorFromRates(rates: ModelRates): CursorPricing {
  return {
    inputPerMillion: rates.inputPerMillion,
    outputPerMillion: rates.outputPerMillion,
    cacheReadPerMillion: rates.cacheReadIsExplicit
      ? rates.cacheReadPerMillion
      : rates.inputPerMillion * CACHE_READ_RATE_MULTIPLIER,
    cacheWritePerMillion: rates.cacheWriteIsExplicit
      ? rates.cacheWritePerMillion
      : rates.inputPerMillion,
  };
}

/**
 * OpenQuota-style resolution over a first-party supplement plus LiteLLM /
 * models.dev catalogs. Supplement always wins (Cursor natives, date overrides,
 * correct Anthropic cache multipliers).
 */
export class ModelPricing {
  readonly updatedAt: string;
  private readonly supplement: PricingSupplement;
  private readonly primary: PricingCatalog;
  private readonly secondary: PricingCatalog;
  private readonly aliases: CompiledAlias[];
  private readonly codexFamilyFallback: Array<{ match: RegExp; pricing: CodexPricing }>;
  private readonly memo = new Map<string, ResolvedModelRates | null>();

  constructor(
    supplement: PricingSupplement,
    primary: PricingCatalog,
    secondary: PricingCatalog,
  ) {
    this.supplement = supplement;
    this.updatedAt = supplement.updatedAt;
    this.primary = primary;
    this.secondary = secondary;
    this.aliases = supplement.cursor.aliases.map((rule) => ({
      pattern: compilePattern(rule.pattern),
      canonical: rule.canonical,
    }));
    this.codexFamilyFallback = supplement.codex.familyFallback.map((entry) => ({
      match: new RegExp(entry.match, 'u'),
      pricing: {
        inputPerMillion: entry.inputPerMillion,
        outputPerMillion: entry.outputPerMillion,
      },
    }));
  }

  applyCursorAlias(model: string): string {
    for (const rule of this.aliases) {
      if (rule.pattern.test(model)) return rule.canonical;
    }
    return model;
  }

  lookupClaude(modelId: string, usageDate?: string): ClaudePricing | undefined {
    const overridden = pickOverride(this.supplement.claude.overrides, modelId, usageDate);
    if (overridden) return overridden;
    return this.supplement.claude.models[modelId];
  }

  claudeFamilyFallback(family: ClaudeFamily): ClaudePricing {
    return this.supplement.claude.familyFallback[family];
  }

  lookupCodex(modelId: string, usageDate?: string): CodexPricing | undefined {
    const overridden = pickOverride(this.supplement.codex.overrides, modelId, usageDate);
    if (overridden) return overridden;
    return this.supplement.codex.current[modelId] ?? this.supplement.codex.historical[modelId];
  }

  codexFamilyFallbacks(): Array<{ match: RegExp; pricing: CodexPricing }> {
    return this.codexFamilyFallback;
  }

  lookupCursorNative(modelId: string): CursorPricing | undefined {
    return this.supplement.cursor.models[modelId];
  }

  cursorFastMultiplier(baseModel: string): number | undefined {
    return this.supplement.cursor.fastMultipliers[baseModel];
  }

  claudeModelCount(): number {
    return Object.keys(this.supplement.claude.models).length;
  }

  codexModelCount(): number {
    return (
      Object.keys(this.supplement.codex.current).length +
      Object.keys(this.supplement.codex.historical).length
    );
  }

  cursorModelCount(): number {
    return Object.keys(this.supplement.cursor.models).length;
  }

  /** Raw supplement tables for callers that still export static maps. */
  getSupplement(): PricingSupplement {
    return this.supplement;
  }

  resolveRates(model: string, usageDate?: string): ResolvedModelRates | undefined {
    const memoKey = `${model}\0${usageDate ?? ''}`;
    const cached = this.memo.get(memoKey);
    if (cached !== undefined) return cached ?? undefined;

    const aliased = this.applyCursorAlias(model);
    const resolved = this.lookupRates(aliased, usageDate);
    this.memo.set(memoKey, resolved ?? null);
    return resolved;
  }

  private lookupRates(modelId: string, usageDate?: string): ResolvedModelRates | undefined {
    const cursor = this.lookupCursorNative(modelId);
    if (cursor) {
      return { ...cursor, source: 'supplement' };
    }

    const claude = this.lookupClaude(modelId, usageDate);
    if (claude) {
      return {
        inputPerMillion: claude.inputPerMillion,
        outputPerMillion: claude.outputPerMillion,
        cacheReadPerMillion: claude.cacheReadPerMillion,
        cacheWritePerMillion: claude.cacheCreatePerMillion,
        source: 'supplement',
      };
    }

    const codex = this.lookupCodex(modelId, usageDate);
    if (codex) {
      return {
        inputPerMillion: codex.inputPerMillion,
        outputPerMillion: codex.outputPerMillion,
        cacheReadPerMillion: codex.inputPerMillion * CACHE_READ_RATE_MULTIPLIER,
        cacheWritePerMillion: codex.inputPerMillion,
        source: 'supplement',
      };
    }

    if (modelId.endsWith('-fast')) {
      const base = modelId.slice(0, -'-fast'.length);
      if (base) {
        const baseRates = this.lookupRates(base, usageDate);
        const multiplier = this.cursorFastMultiplier(base);
        if (baseRates && multiplier !== undefined) {
          return {
            inputPerMillion: baseRates.inputPerMillion * multiplier,
            outputPerMillion: baseRates.outputPerMillion * multiplier,
            cacheReadPerMillion: baseRates.cacheReadPerMillion * multiplier,
            cacheWritePerMillion: baseRates.cacheWritePerMillion * multiplier,
            source: 'fast_multiplier',
          };
        }
      }
    }

    for (const family of CLAUDE_FAMILIES) {
      if (!modelId.includes(family)) continue;
      const fallback = this.claudeFamilyFallback(family);
      return {
        inputPerMillion: fallback.inputPerMillion,
        outputPerMillion: fallback.outputPerMillion,
        cacheReadPerMillion: fallback.cacheReadPerMillion,
        cacheWritePerMillion: fallback.cacheCreatePerMillion,
        source: 'family_fallback',
      };
    }

    return undefined;
  }

  /** Catalog coverage for tooling / doctor; resolve still prefers the supplement. */
  catalogModelCount(): number {
    return this.primary.entries.size + this.secondary.entries.size;
  }

  catalogCursor(modelId: string): CursorPricing | undefined {
    const hit =
      findCatalogRates(this.primary, modelId, ['cursor', 'xai', 'google', 'openai', 'anthropic']) ??
      findCatalogRates(this.secondary, modelId, ['cursor', 'xai', 'google', 'openai', 'anthropic']);
    if (!hit) return undefined;
    return cursorFromRates(hit.rates);
  }
}

export function modelPricingFromPack(parts: {
  supplement: PricingSupplement;
  litellm: Parameters<typeof catalogFromCompact>[0];
  modelsDev: Parameters<typeof catalogFromCompact>[0];
}): ModelPricing {
  return new ModelPricing(
    parts.supplement,
    catalogFromCompact(parts.litellm),
    catalogFromCompact(parts.modelsDev),
  );
}
