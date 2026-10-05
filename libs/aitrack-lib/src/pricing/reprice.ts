import type { MachineFile, ProviderDay } from '../data/types.js';
import { approximatelyEqual } from '../data/validate.js';
import { getProvider, syncedProviderKeys } from '../providers/index.js';
import type { FallbackCollector } from './fallback.js';
import { resolveModelCost } from './resolve.js';

export interface RepriceResult {
  /** Whether any stored cost was replaced. */
  isTouched: boolean;
  /** Claude model-days left alone because they predate the cache breakdown. */
  legacySkipped: number;
}

/** Recompute model and day costs, ignoring float noise from summed reader estimates. */
function repriceProviderDay(
  providerKey: string,
  date: string,
  providerDay: ProviderDay,
  fallbacks?: FallbackCollector,
): RepriceResult {
  let dayTotal = 0;
  let modelCount = 0;
  let isCostComplete = true;
  let isTouched = false;
  let legacySkipped = 0;

  for (const [model, counts] of Object.entries(providerDay.byModel)) {
    modelCount++;
    const cost = resolveModelCost(providerKey, model, counts, date, 'recompute', fallbacks);
    if (cost === undefined) {
      if (counts.costUSD === undefined) {
        isCostComplete = false;
      } else {
        dayTotal += counts.costUSD;
        if (getProvider(providerKey)?.pricing.repriceRequiresBreakdown) legacySkipped++;
      }
      continue;
    }
    if (
      counts.costUSD === undefined ||
      !approximatelyEqual(counts.costUSD, cost) ||
      counts.hasUnpricedTokens
    ) {
      counts.costUSD = cost;
      delete counts.hasUnpricedTokens;
      isTouched = true;
    }
    dayTotal += cost;
  }

  if (
    providerDay.totals.hasUnpricedTokens &&
    !Object.values(providerDay.byModel).some((counts) => counts.hasUnpricedTokens)
  ) {
    delete providerDay.totals.hasUnpricedTokens;
    isTouched = true;
  }

  // A day total is only safe to re-derive once every model in it has a cost.
  if (
    modelCount > 0 &&
    isCostComplete &&
    (providerDay.totals.costUSD === undefined ||
      !approximatelyEqual(providerDay.totals.costUSD, dayTotal))
  ) {
    providerDay.totals.costUSD = dayTotal;
    isTouched = true;
  }

  return { isTouched, legacySkipped };
}

/** Reprice every synced provider-day in a machine file, in place. */
export function repriceMachineDays(
  days: MachineFile['days'],
  fallbacks?: FallbackCollector,
): RepriceResult {
  let isTouched = false;
  let legacySkipped = 0;

  for (const [date, providers] of Object.entries(days)) {
    for (const providerKey of syncedProviderKeys()) {
      const providerDay = providers[providerKey];
      if (!providerDay) continue;
      const result = repriceProviderDay(providerKey, date, providerDay, fallbacks);
      isTouched ||= result.isTouched;
      legacySkipped += result.legacySkipped;
    }
  }

  return { isTouched, legacySkipped };
}
