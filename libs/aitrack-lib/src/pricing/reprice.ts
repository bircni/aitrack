import { COMPACTED_MODEL } from '../data/compact.js';
import type { MachineFile, ProviderDay, TokenCounts } from '../data/types.js';
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

function tokenSum(counts: TokenCounts): number {
  return counts.inputTokens + counts.outputTokens;
}

/**
 * A project has no model split to reprice from, so its stored costs follow the
 * day: scaled by the change in the day's total. Only when the projects cover
 * the whole day, otherwise the share of each is unknown and they stay as written.
 */
function rescaleProjectCosts(providerDay: ProviderDay, previousTotal: number | undefined): boolean {
  const { byProject, totals } = providerDay;
  if (byProject === undefined || previousTotal === undefined || previousTotal <= 0) return false;
  if (totals.costUSD === undefined || approximatelyEqual(previousTotal, totals.costUSD)) {
    return false;
  }
  const projects = Object.values(byProject);
  if (projects.reduce((sum, counts) => sum + tokenSum(counts), 0) !== tokenSum(totals)) {
    return false;
  }
  const factor = totals.costUSD / previousTotal;
  for (const counts of projects) {
    if (counts.costUSD !== undefined) counts.costUSD *= factor;
  }
  return true;
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
  const previousTotal = providerDay.totals.costUSD;

  for (const [model, counts] of Object.entries(providerDay.byModel)) {
    modelCount++;
    if (model === COMPACTED_MODEL) {
      // The models are gone, so the stored cost cannot be repriced.
      if (counts.costUSD === undefined) isCostComplete = false;
      else dayTotal += counts.costUSD;
      continue;
    }
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
  if (rescaleProjectCosts(providerDay, previousTotal)) isTouched = true;

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
