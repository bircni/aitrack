import type { ClaudeFamily } from '../data/modelId.js';
import type { ClaudePricing, CodexPricing, CursorPricing, PricingOverride } from './types.js';

export interface PricingSupplementClaude {
  models: Record<string, ClaudePricing>;
  overrides: Record<string, Array<PricingOverride<ClaudePricing>>>;
  familyFallback: Record<ClaudeFamily, ClaudePricing>;
}

export interface PricingSupplementCodex {
  current: Record<string, CodexPricing>;
  historical: Record<string, CodexPricing>;
  overrides: Record<string, Array<PricingOverride<CodexPricing>>>;
  familyFallback: Array<{
    match: string;
    inputPerMillion: number;
    outputPerMillion: number;
  }>;
}

export interface PricingSupplementCursor {
  models: Record<string, CursorPricing>;
  fastMultipliers: Record<string, number>;
  aliases: Array<{ pattern: string; canonical: string }>;
}

/**
 * First-party pricing pack: Cursor-native rates, aliases, date overrides,
 * historical Codex rows, and Claude cache multipliers catalogs get wrong.
 * Published on the orphan `pricing` branch so installs can refresh without a
 * CLI release.
 */
export interface PricingSupplement {
  updatedAt: string;
  comment?: string;
  claude: PricingSupplementClaude;
  codex: PricingSupplementCodex;
  cursor: PricingSupplementCursor;
}

export interface PricingManifest {
  schemaVersion: 1;
  updatedAt: string;
  files: {
    supplement: string;
    litellm: string;
    modelsDev: string;
  };
  /** Optional SHA-256 hex digests for cache validation. */
  hashes?: Partial<Record<'supplement' | 'litellm' | 'modelsDev', string>>;
}

export const PRICING_BRANCH = 'pricing';
export const PRICING_REPO = 'bircni/aitrack';

/**
 * Overridable for tests / mirrors.
 *
 * Default is jsDelivr's git CDN (`@pricing`), which publishes orphan-branch
 * packs immediately. GitHub raw for a brand-new `pricing` branch can 404 for a
 * while after the first push; set `AITRACK_PRICING_URL` to
 * `https://raw.githubusercontent.com/bircni/aitrack/pricing` once that works.
 */
export function pricingPackBaseUrl(): string {
  const fromEnv = process.env.AITRACK_PRICING_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/u, '');
  return `https://cdn.jsdelivr.net/gh/${PRICING_REPO}@${PRICING_BRANCH}`;
}

export function pricingPackUrls(baseUrl = pricingPackBaseUrl()): {
  manifest: string;
  supplement: string;
  litellm: string;
  modelsDev: string;
} {
  return {
    manifest: `${baseUrl}/manifest.json`,
    supplement: `${baseUrl}/supplement.json`,
    litellm: `${baseUrl}/litellm.json`,
    modelsDev: `${baseUrl}/models_dev.json`,
  };
}
