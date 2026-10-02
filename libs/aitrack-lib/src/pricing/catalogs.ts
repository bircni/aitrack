import { isRecord } from '../data/guards.js';
import {
  catalogFromLiteLLM,
  catalogFromModelsDev,
  findCatalogRates,
  type ModelRates,
  type PricingCatalog,
} from './codecs.js';
import type { PricingSupplement } from './packMeta.js';

export interface PricingCatalogs {
  primary: PricingCatalog;
  secondary: PricingCatalog;
}

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MODELS_DEV_URL = 'https://models.dev/api.json';

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'aitrack-pricing' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} for ${url}`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error(`invalid pricing catalog for ${url}`);
  return body;
}

export async function fetchPricingCatalogs(): Promise<PricingCatalogs> {
  const [litellm, modelsDev] = await Promise.all([
    fetchJson(LITELLM_URL),
    fetchJson(MODELS_DEV_URL),
  ]);
  const retrievedAt = new Date().toISOString();
  return {
    primary: catalogFromLiteLLM(litellm, retrievedAt),
    secondary: catalogFromModelsDev(modelsDev, retrievedAt),
  };
}

export function findPricingCatalogRates(
  catalogs: PricingCatalogs,
  modelId: string,
  providers: string[],
): ModelRates | undefined {
  return (
    findCatalogRates(catalogs.primary, modelId, providers) ??
    findCatalogRates(catalogs.secondary, modelId, providers)
  )?.rates;
}

export type PricingFinding =
  | { kind: 'ok'; modelId: string; summary: string }
  | {
      kind: 'drift';
      modelId: string;
      summary: string;
      isInOk: boolean;
      isOutOk: boolean;
      saw: number[];
    }
  | { kind: 'unverified'; modelId: string; summary: string; where: string };

export interface PricingComparison {
  drift: number;
  unverified: number;
}

export function pricingRatesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function ratesSummary(input: number, output: number): string {
  return `$${String(input)}/$${String(output)}`;
}

export function comparePricingTable(options: {
  table: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
  providers: string[];
  primary: PricingCatalog;
  secondary: PricingCatalog;
}): PricingFinding[] {
  const findings: PricingFinding[] = [];

  for (const [modelId, pricing] of Object.entries(options.table)) {
    const summary = ratesSummary(pricing.inputPerMillion, pricing.outputPerMillion);
    const rates = findPricingCatalogRates(options, modelId, options.providers);
    if (!rates) {
      findings.push({
        kind: 'unverified',
        modelId,
        summary,
        where: `${options.providers.join('|')}/${modelId}`,
      });
      continue;
    }
    const isInOk = pricingRatesEqual(pricing.inputPerMillion, rates.inputPerMillion);
    const isOutOk = pricingRatesEqual(pricing.outputPerMillion, rates.outputPerMillion);
    findings.push(
      isInOk && isOutOk
        ? { kind: 'ok', modelId, summary }
        : {
            kind: 'drift',
            modelId,
            summary,
            isInOk,
            isOutOk,
            saw: [rates.inputPerMillion, rates.outputPerMillion],
          },
    );
  }

  return findings;
}

export function tallyPricingFindings(findings: PricingFinding[]): PricingComparison {
  return {
    drift: findings.filter((f) => f.kind === 'drift').length,
    unverified: findings.filter((f) => f.kind === 'unverified').length,
  };
}

/**
 * Patch Claude models + Codex `current` IO in a supplement from catalogs.
 * Preserves Claude cache multipliers unless the catalog published them explicitly.
 */
export function applyCatalogRatesToSupplement(
  supplement: PricingSupplement,
  catalogs: PricingCatalogs,
): { claudeChanged: string[]; codexChanged: string[] } {
  const claudeChanged: string[] = [];
  for (const [id, pricing] of Object.entries(supplement.claude.models)) {
    const rates = findPricingCatalogRates(catalogs, id, ['anthropic']);
    if (!rates) continue;
    const cacheWriteNeedsUpdate =
      rates.cacheWriteIsExplicit &&
      !pricingRatesEqual(pricing.cacheCreatePerMillion, rates.cacheWritePerMillion);
    const cacheReadNeedsUpdate =
      rates.cacheReadIsExplicit &&
      !pricingRatesEqual(pricing.cacheReadPerMillion, rates.cacheReadPerMillion);
    const ioMatches =
      pricingRatesEqual(pricing.inputPerMillion, rates.inputPerMillion) &&
      pricingRatesEqual(pricing.outputPerMillion, rates.outputPerMillion);
    if (ioMatches && !cacheWriteNeedsUpdate && !cacheReadNeedsUpdate) {
      continue;
    }
    const inputRatio =
      pricing.inputPerMillion === 0 ? 1 : rates.inputPerMillion / pricing.inputPerMillion;
    pricing.cacheCreatePerMillion = rates.cacheWriteIsExplicit
      ? rates.cacheWritePerMillion
      : pricing.cacheCreatePerMillion * inputRatio;
    pricing.cacheReadPerMillion = rates.cacheReadIsExplicit
      ? rates.cacheReadPerMillion
      : pricing.cacheReadPerMillion * inputRatio;
    pricing.inputPerMillion = rates.inputPerMillion;
    pricing.outputPerMillion = rates.outputPerMillion;
    claudeChanged.push(id);
  }

  const codexChanged: string[] = [];
  for (const [id, pricing] of Object.entries(supplement.codex.current)) {
    const rates = findPricingCatalogRates(catalogs, id, ['openai']);
    if (!rates) continue;
    if (
      pricingRatesEqual(pricing.inputPerMillion, rates.inputPerMillion) &&
      pricingRatesEqual(pricing.outputPerMillion, rates.outputPerMillion)
    ) {
      continue;
    }
    pricing.inputPerMillion = rates.inputPerMillion;
    pricing.outputPerMillion = rates.outputPerMillion;
    codexChanged.push(id);
  }

  return { claudeChanged, codexChanged };
}
