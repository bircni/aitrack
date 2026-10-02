/**
 * Compact pricing catalogs shared by the orphan `pricing` branch publish
 * artifact and the local disk cache. Rates are USD per million tokens.
 *
 * Short keys keep snapshots small: i/o/cw/cr, plus optional long-context and
 * fast-multiplier fields. LiteLLM publishes per-token costs; models.dev is
 * already per-million.
 */

import { isRecord } from '../data/guards.js';

export interface CompactModelRates {
  i: number;
  o: number;
  cw: number;
  cr: number;
  ia?: number;
  oa?: number;
  cwa?: number;
  cra?: number;
  fast?: number;
  /** When false, cache-read was defaulted (0.1× input), not published. */
  cre?: boolean;
  /** When false, cache-write was defaulted (usually = input), not published. */
  cwe?: boolean;
}

export interface CompactCatalog {
  retrievedAt: string;
  models: Record<string, CompactModelRates>;
}

export interface ModelRates {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
  inputAbove200kPerMillion?: number;
  outputAbove200kPerMillion?: number;
  cacheWriteAbove200kPerMillion?: number;
  cacheReadAbove200kPerMillion?: number;
  fastMultiplier: number;
  cacheReadIsExplicit: boolean;
  cacheWriteIsExplicit: boolean;
}

export interface PricingCatalog {
  retrievedAt?: string;
  entries: Map<string, ModelRates>;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compactFromRates(rates: ModelRates): CompactModelRates {
  const model: CompactModelRates = {
    i: rates.inputPerMillion,
    o: rates.outputPerMillion,
    cw: rates.cacheWritePerMillion,
    cr: rates.cacheReadPerMillion,
  };
  if (rates.inputAbove200kPerMillion !== undefined) model.ia = rates.inputAbove200kPerMillion;
  if (rates.outputAbove200kPerMillion !== undefined) model.oa = rates.outputAbove200kPerMillion;
  if (rates.cacheWriteAbove200kPerMillion !== undefined) {
    model.cwa = rates.cacheWriteAbove200kPerMillion;
  }
  if (rates.cacheReadAbove200kPerMillion !== undefined) {
    model.cra = rates.cacheReadAbove200kPerMillion;
  }
  if (rates.fastMultiplier !== 1) model.fast = rates.fastMultiplier;
  if (!rates.cacheReadIsExplicit) model.cre = false;
  if (!rates.cacheWriteIsExplicit) model.cwe = false;
  return model;
}

function ratesFromCompact(model: CompactModelRates): ModelRates {
  return {
    inputPerMillion: model.i,
    outputPerMillion: model.o,
    cacheWritePerMillion: model.cw,
    cacheReadPerMillion: model.cr,
    inputAbove200kPerMillion: model.ia,
    outputAbove200kPerMillion: model.oa,
    cacheWriteAbove200kPerMillion: model.cwa,
    cacheReadAbove200kPerMillion: model.cra,
    fastMultiplier: model.fast ?? 1,
    cacheReadIsExplicit: model.cre !== false,
    cacheWriteIsExplicit: model.cwe !== false,
  };
}

/** Prefer first-party provider keys when both `anthropic/x` and `x` exist. */
export function preferProviderKey(key: string): number {
  if (key.startsWith('anthropic/') || key.startsWith('openai/') || key.startsWith('cursor/')) {
    return 0;
  }
  if (key.startsWith('xai/') || key.startsWith('google/')) return 1;
  if (key.includes('/')) return 3;
  return 2;
}

export function catalogFromCompact(data: CompactCatalog): PricingCatalog {
  const entries = new Map<string, ModelRates>();
  for (const [key, model] of Object.entries(data.models)) {
    entries.set(key, ratesFromCompact(model));
  }
  return { retrievedAt: data.retrievedAt, entries };
}

export function compactFromCatalog(catalog: PricingCatalog): CompactCatalog {
  const models: Record<string, CompactModelRates> = {};
  const keys = [...catalog.entries.keys()].toSorted((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const rates = catalog.entries.get(key);
    if (rates) models[key] = compactFromRates(rates);
  }
  return {
    retrievedAt: catalog.retrievedAt ?? new Date().toISOString(),
    models,
  };
}

function scalePerMillion(value: unknown): number | undefined {
  const amount = number(value);
  return amount === undefined ? undefined : amount * 1e6;
}

function litellmEntryToRates(entry: Record<string, unknown>): ModelRates | undefined {
  const input = number(entry.input_cost_per_token);
  const output = number(entry.output_cost_per_token);
  if (input === undefined || output === undefined) return undefined;
  const cacheWrite = number(entry.cache_creation_input_token_cost);
  const cacheRead = number(entry.cache_read_input_token_cost);
  const specific = entry.provider_specific_entry;
  const fast = isRecord(specific) ? number(specific.fast) : undefined;
  return {
    inputPerMillion: input * 1e6,
    outputPerMillion: output * 1e6,
    cacheWritePerMillion: (cacheWrite ?? input) * 1e6,
    cacheReadPerMillion: (cacheRead ?? input * 0.1) * 1e6,
    inputAbove200kPerMillion: scalePerMillion(entry.input_cost_per_token_above_200k_tokens),
    outputAbove200kPerMillion: scalePerMillion(entry.output_cost_per_token_above_200k_tokens),
    cacheWriteAbove200kPerMillion: scalePerMillion(
      entry.cache_creation_input_token_cost_above_200k_tokens,
    ),
    cacheReadAbove200kPerMillion: scalePerMillion(
      entry.cache_read_input_token_cost_above_200k_tokens,
    ),
    fastMultiplier: fast ?? 1,
    cacheReadIsExplicit: cacheRead !== undefined,
    cacheWriteIsExplicit: cacheWrite !== undefined,
  };
}

const LITELLM_KEEP =
  /^(anthropic\/|openai\/|cursor\/|xai\/|google\/|claude-|gpt-|o[1-9]|codex|vercel_ai_gateway\/anthropic\/|vercel_ai_gateway\/openai\/)/u;

/**
 * Parse LiteLLM's `model_prices_and_context_window.json`, keeping first-party
 * and bare Claude/GPT keys. Aggregator markups (Bedrock regional, APAC, …)
 * are dropped so lookups stay on published list prices.
 */
export function catalogFromLiteLLM(
  root: Record<string, unknown>,
  retrievedAt = new Date().toISOString(),
): PricingCatalog {
  const entries = new Map<string, ModelRates>();
  for (const [key, value] of Object.entries(root)) {
    if (key === 'sample_spec' || !LITELLM_KEEP.test(key) || !isRecord(value)) continue;
    const rates = litellmEntryToRates(value);
    if (!rates) continue;
    entries.set(key, rates);
  }
  if (entries.size === 0) throw new Error('LiteLLM feed produced no usable entries');
  return { retrievedAt, entries };
}

const MODELS_DEV_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'cursor',
  'xai',
  'google',
  'google-vertex',
]);

function modelsDevEntryToRates(cost: Record<string, unknown>): ModelRates | undefined {
  const input = number(cost.input);
  const output = number(cost.output);
  if (input === undefined || output === undefined) return undefined;
  if (input === 0 && output === 0) return undefined;
  const cacheWrite = number(cost.cache_write);
  const cacheRead = number(cost.cache_read);
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheWritePerMillion: cacheWrite ?? input,
    cacheReadPerMillion: cacheRead ?? input * 0.1,
    fastMultiplier: 1,
    cacheReadIsExplicit: cacheRead !== undefined,
    cacheWriteIsExplicit: cacheWrite !== undefined,
  };
}

/**
 * Parse models.dev `api.json`. Keep only provider-qualified keys so lookups
 * cannot leak rates across a restricted `providers` allowlist via bare aliases.
 */
export function catalogFromModelsDev(
  root: Record<string, unknown>,
  retrievedAt = new Date().toISOString(),
): PricingCatalog {
  const entries = new Map<string, ModelRates>();
  for (const providerName of MODELS_DEV_PROVIDERS) {
    const provider = root[providerName];
    if (!isRecord(provider) || !isRecord(provider.models)) continue;

    for (const [modelId, value] of Object.entries(provider.models)) {
      if (!isRecord(value) || !isRecord(value.cost)) continue;
      const rates = modelsDevEntryToRates(value.cost);
      if (!rates) continue;
      entries.set(`${providerName}/${modelId}`, rates);
    }
  }

  if (entries.size === 0) throw new Error('models.dev feed produced no usable entries');
  return { retrievedAt, entries };
}

function keyMatchesProviders(key: string, providers: string[]): boolean {
  return providers.some(
    (provider) =>
      key.startsWith(`${provider}/`) || key.startsWith(`vercel_ai_gateway/${provider}/`),
  );
}

/** True when every qualified `…/modelId` owner in the catalog is an allowed provider. */
function bareAliasAllowed(
  catalog: PricingCatalog,
  modelId: string,
  providers: string[],
): boolean {
  const suffix = `/${modelId}`;
  for (const key of catalog.entries.keys()) {
    if (key.endsWith(suffix) && !keyMatchesProviders(key, providers)) return false;
  }
  return true;
}

function preferHit(
  a: { key: string; rates: ModelRates },
  b: { key: string; rates: ModelRates },
): number {
  return preferProviderKey(a.key) - preferProviderKey(b.key) || a.key.length - b.key.length;
}

export function findCatalogRates(
  catalog: PricingCatalog,
  modelId: string,
  providers: string[] = ['anthropic', 'openai', 'cursor', 'xai', 'google'],
): { key: string; rates: ModelRates } | undefined {
  function isAllowed(key: string): boolean {
    if (!key.includes('/')) return bareAliasAllowed(catalog, modelId, providers);
    return keyMatchesProviders(key, providers);
  }

  const hits: Array<{ key: string; rates: ModelRates }> = [];
  const candidates = [modelId, ...providers.map((provider) => `${provider}/${modelId}`)];
  for (const key of candidates) {
    const rates = catalog.entries.get(key);
    if (rates && isAllowed(key)) hits.push({ key, rates });
  }

  if (hits.length === 0) {
    const suffix = `/${modelId}`;
    for (const [key, rates] of catalog.entries) {
      if (key.endsWith(suffix) && isAllowed(key)) hits.push({ key, rates });
    }
  }

  if (hits.length === 0) return undefined;
  hits.sort(preferHit);
  return hits[0];
}
