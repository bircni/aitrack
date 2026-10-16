import type { DayEntry, DayMap, ProviderData, TokenCounts } from './types.js';

export function getOrCreateDay(dayMap: DayMap, date: string): DayEntry {
  let day = dayMap.get(date);
  if (day === undefined) {
    day = { inputTokens: 0, outputTokens: 0, byModel: {} };
    dayMap.set(date, day);
  }
  return day;
}

export function toLocalDateString(ts: string | Date): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
}

/** Null when unparseable; toLocalDateString would give a "NaN-NaN-NaN" key that gets synced and counted. */
export function tryLocalDateString(ts: string | Date): string | null {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return Number.isNaN(d.getTime()) ? null : toLocalDateString(d);
}

export function addTokenCounts(dest: TokenCounts, source: TokenCounts): void {
  dest.inputTokens += source.inputTokens;
  dest.outputTokens += source.outputTokens;
  // Unrolled rather than looped over TOKEN_BREAKDOWN_FIELDS: this runs once per message.
  if (source.rawInputTokens !== undefined) {
    dest.rawInputTokens = (dest.rawInputTokens ?? 0) + source.rawInputTokens;
  }
  if (source.cachedInputTokens !== undefined) {
    dest.cachedInputTokens = (dest.cachedInputTokens ?? 0) + source.cachedInputTokens;
  }
  if (source.cacheCreationInputTokens !== undefined) {
    dest.cacheCreationInputTokens =
      (dest.cacheCreationInputTokens ?? 0) + source.cacheCreationInputTokens;
  }
  if (source.cacheCreation1hInputTokens !== undefined) {
    dest.cacheCreation1hInputTokens =
      (dest.cacheCreation1hInputTokens ?? 0) + source.cacheCreation1hInputTokens;
  }
  if (source.hasUnpricedTokens) dest.hasUnpricedTokens = true;
  if (source.costUSD !== undefined) {
    dest.costUSD = (dest.costUSD ?? 0) + source.costUSD;
  }
}

/**
 * Add one model's usage onto a day — the model row and the day totals.
 *
 * Readers call this once per event. `mergeDayMaps` must not: the source day
 * already holds both the totals and the per-model rows, so that would
 * double-count.
 */
export function addModelUsage(day: DayEntry, model: string, counts: TokenCounts): void {
  const rec = (day.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
  const pricedCounts =
    counts.costUSD === undefined && counts.inputTokens + counts.outputTokens > 0
      ? { ...counts, hasUnpricedTokens: true }
      : counts;
  addTokenCounts(rec, pricedCounts);
  addTokenCounts(day, pricedCounts);
}

/** Merge one DayMap into another, summing day totals, breakdowns and models. */
export function mergeDayMaps(dst: DayMap, source: DayMap): void {
  for (const [date, sourceDay] of source) {
    const dstDay = getOrCreateDay(dst, date);
    addTokenCounts(dstDay, sourceDay);
    for (const [model, counts] of Object.entries(sourceDay.byModel)) {
      const modelTotals = (dstDay.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
      addTokenCounts(modelTotals, counts);
    }
  }
}

export function filterDayMapByYear(dayMap: DayMap, year: number): DayMap {
  const prefix = `${String(year)}-`;
  return new Map([...dayMap].filter(([date]) => date.startsWith(prefix)));
}

export function filterProviderDataByYear(data: ProviderData, year: number): ProviderData {
  const filtered: ProviderData = {};
  for (const [providerKey, dayMap] of Object.entries(data)) {
    const next = filterDayMapByYear(dayMap, year);
    if (next.size > 0) filtered[providerKey] = next;
  }
  return filtered;
}
