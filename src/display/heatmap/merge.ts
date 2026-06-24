import { getOrCreateDay } from '../../data/dayMap.js';
import type { DayMap, ProviderData } from '../../data/types.js';

/** Merge every provider DayMap into one (per-day and per-model sums). */
export function mergeAllProviderDayMaps(providerData: ProviderData): DayMap {
  const result: DayMap = new Map();
  for (const dayMap of Object.values(providerData)) {
    for (const [date, sourceDay] of dayMap) {
      const dstDay = getOrCreateDay(result, date);
      dstDay.inputTokens += sourceDay.inputTokens;
      dstDay.outputTokens += sourceDay.outputTokens;
      if (sourceDay.costUSD !== undefined)
        dstDay.costUSD = (dstDay.costUSD ?? 0) + sourceDay.costUSD;
      for (const [model, counts] of Object.entries(sourceDay.byModel)) {
        const modelTotals = (dstDay.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
        modelTotals.inputTokens += counts.inputTokens;
        modelTotals.outputTokens += counts.outputTokens;
        if (counts.costUSD !== undefined) {
          modelTotals.costUSD = (modelTotals.costUSD ?? 0) + counts.costUSD;
        }
      }
    }
  }
  return result;
}
