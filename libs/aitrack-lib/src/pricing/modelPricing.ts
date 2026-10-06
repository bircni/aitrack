import { createHash } from 'node:crypto';

import { CACHE_READ_RATE_MULTIPLIER } from '../constants.js';
import { isRecord } from '../data/guards.js';
import { type ClaudeFamily } from '../data/modelId.js';
import { findPricingCatalogRates, type PricingCatalogs } from './catalogs.js';
import { catalogFromCompact, type PricingCatalog } from './codecs.js';
import type { PricingSupplement } from './packMeta.js';
import type { ClaudePricing, CodexPricing, CursorPricing, PricingOverride } from './types.js';

function canonicalPricing(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry: unknown) => canonicalPricing(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalPricing(entry)]),
  );
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

/**
 * First-party rates and overrides, with catalog gap filling for Claude and Codex.
 */
export class ModelPricing {
  readonly updatedAt: string;
  readonly fingerprint: string;
  private readonly supplement: PricingSupplement;
  private readonly catalogs: PricingCatalogs;
  private readonly aliases: CompiledAlias[];
  private readonly codexFamilyFallback: Array<{ match: RegExp; pricing: CodexPricing }>;

  constructor(supplement: PricingSupplement, primary: PricingCatalog, secondary: PricingCatalog) {
    this.fingerprint = createHash('sha256')
      .update(
        JSON.stringify(
          canonicalPricing([
            { ...supplement, updatedAt: undefined, comment: undefined },
            [...primary.entries].toSorted(([a], [b]) => a.localeCompare(b)),
            [...secondary.entries].toSorted(([a], [b]) => a.localeCompare(b)),
          ]),
        ),
      )
      .digest('hex');
    this.supplement = supplement;
    this.updatedAt = supplement.updatedAt;
    this.catalogs = { primary, secondary };
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

  pricingOverrides<Provider extends 'claude' | 'codex'>(
    provider: Provider,
  ): PricingSupplement[Provider]['overrides'] {
    return this.supplement[provider].overrides;
  }

  pricingTable<Provider extends 'claude' | 'codex' | 'cursor'>(
    provider: Provider,
  ): PricingSupplement[Provider] {
    return this.supplement[provider];
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

  /** Gap-fill Claude rates from catalogs when the supplement has no row. */
  lookupCatalogClaude(modelId: string): ClaudePricing | undefined {
    const rates = findPricingCatalogRates(this.catalogs, modelId, ['anthropic']);
    if (!rates) return undefined;
    return {
      inputPerMillion: rates.inputPerMillion,
      outputPerMillion: rates.outputPerMillion,
      cacheReadPerMillion: rates.cacheReadIsExplicit
        ? rates.cacheReadPerMillion
        : rates.inputPerMillion * CACHE_READ_RATE_MULTIPLIER,
      cacheCreatePerMillion: rates.cacheWriteIsExplicit
        ? rates.cacheWritePerMillion
        : rates.inputPerMillion * 1.25,
    };
  }

  /** Gap-fill Codex rates from catalogs when the supplement has no row. */
  lookupCatalogCodex(modelId: string): CodexPricing | undefined {
    const rates = findPricingCatalogRates(this.catalogs, modelId, ['openai']);
    if (!rates) return undefined;
    return {
      inputPerMillion: rates.inputPerMillion,
      outputPerMillion: rates.outputPerMillion,
    };
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
