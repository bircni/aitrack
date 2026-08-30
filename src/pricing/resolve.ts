import type { TokenCounts } from '../data/types.js';
import { getProvider } from '../providers/index.js';
import type { FallbackCollector } from './fallback.js';

export type ResolveModelCostMode = 'merge' | 'recompute';

export function resolveModelCost(
  providerKey: string,
  model: string,
  counts: TokenCounts,
  usageDate?: string,
  mode: ResolveModelCostMode = 'merge',
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
