import type { ProviderData } from '../data/types.js';
import { findClaudePricing } from './claude.js';
import { findCodexPricing } from './codex.js';
import {
  createFallbackCollector,
  type FallbackCollector,
  reportFallbackPricing,
} from './fallback.js';

/**
 * Record family-fallback hits for models already loaded.
 *
 * Parse-time collection misses cache hits: a cached transcript never calls the
 * pricer, so the warning used to vanish on the second run and never appeared
 * on `show` or `usage` at all.
 */
export function recordPricingFallbacks(
  providerData: ProviderData,
  fallbacks: FallbackCollector,
): void {
  for (const [providerKey, dayMap] of Object.entries(providerData)) {
    for (const [date, day] of dayMap) {
      for (const model of Object.keys(day.byModel)) {
        if (providerKey === 'claude_code') findClaudePricing(model, date, fallbacks);
        else if (providerKey === 'codex') findCodexPricing(model, date, fallbacks);
      }
    }
  }
}

/** Warn when a loaded model was priced from a family fallback. */
export function warnAboutPricingFallbacks(providerData: ProviderData): void {
  const fallbacks = createFallbackCollector();
  recordPricingFallbacks(providerData, fallbacks);
  reportFallbackPricing(fallbacks);
}
