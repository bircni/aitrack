import { mergeDayMaps } from '../../data/dayMap.js';
import type { DayMap, ProviderData } from '../../data/types.js';

/** Merge every provider DayMap into one (per-day and per-model sums). */
export function mergeAllProviderDayMaps(providerData: ProviderData): DayMap {
  const result: DayMap = new Map();
  for (const dayMap of Object.values(providerData)) {
    mergeDayMaps(result, dayMap);
  }
  return result;
}
