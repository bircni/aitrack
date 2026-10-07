import type { TokenCounts } from '../data/types.js';
import { getProvider } from '../providers/index.js';
import type { PriceMode } from '../providers/types.js';
import type { FallbackCollector } from './fallback.js';

export function resolveModelCost(
  providerKey: string,
  model: string,
  counts: TokenCounts,
  usageDate?: string,
  mode: PriceMode = 'merge',
  fallbacks?: FallbackCollector,
): number | undefined {
  if (mode === 'merge' && counts.costUSD !== undefined) return counts.costUSD;

  return getProvider(providerKey)?.pricing.priceModelCost(
    model,
    counts,
    usageDate,
    mode,
    fallbacks,
  );
}
