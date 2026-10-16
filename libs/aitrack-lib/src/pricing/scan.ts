import type { ProviderData } from '../data/types.js';
import { syncedProviders } from '../providers/index.js';
import {
  createFallbackCollector,
  type FallbackCollector,
  reportFallbackPricing,
} from './fallback.js';

/** Record family-fallback hits for models already loaded; merge mode prices every row. */
export function recordPricingFallbacks(
  providerData: ProviderData,
  fallbacks: FallbackCollector,
): void {
  for (const { descriptor, pricing } of syncedProviders()) {
    for (const [date, day] of providerData[descriptor.key] ?? []) {
      for (const [model, counts] of Object.entries(day.byModel)) {
        pricing.priceModelCost(model, counts, date, 'merge', fallbacks);
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
