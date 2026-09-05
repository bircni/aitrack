import { providerLabel } from '../display/providers.js';
import { type AggregateModelsFilter, aggregateModelsByDayMap, dateInFilter } from './aggregate.js';
import { compareByCostThenTokens } from './sort.js';
import type { DayMap, ProviderData } from './types.js';

/**
 * Ranking days and models by tokens or cost.
 *
 * This is data work, not presentation — it lived in `commands/top.ts`, which
 * also owned the JSON envelope and the terminal table. `data/usageReport.ts`
 * already sets the pattern this follows: pure, no I/O, no output.
 */
export type TopSort = 'tokens' | 'cost';

interface TopSortable {
  tokens: number;
  cost: number | null;
}

export interface DayEntryAccumulator extends TopSortable {
  date: string;
  byProvider: Record<string, number>;
}

export interface ModelAccumulator extends TopSortable {
  providerKey: string;
  provider: string;
  model: string;
  days: number;
}

function compareTopEntries(a: TopSortable, b: TopSortable, sort: TopSort): number {
  if (sort === 'tokens') {
    return b.tokens - a.tokens || (b.cost ?? 0) - (a.cost ?? 0);
  }
  return compareByCostThenTokens(
    { tokens: a.tokens, cost: a.cost },
    { tokens: b.tokens, cost: b.cost },
  );
}

export function topProviderKey(byProvider: Record<string, number>): string | null {
  const top = Object.entries(byProvider).toSorted((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

export function topDays(
  providerData: ProviderData,
  limit: number,
  sort: TopSort,
  filter?: AggregateModelsFilter,
): DayEntryAccumulator[] {
  const byDate = new Map<string, DayEntryAccumulator>();
  for (const [providerKey, dayMap] of Object.entries(providerData)) {
    for (const [date, day] of dayMap) {
      if (!dateInFilter(date, filter)) continue;
      let accumulator = byDate.get(date);
      if (!accumulator) {
        accumulator = { date, tokens: 0, cost: null, byProvider: {} };
        byDate.set(date, accumulator);
      }
      const dayTokens = day.inputTokens + day.outputTokens;
      accumulator.tokens += dayTokens;
      accumulator.byProvider[providerKey] = (accumulator.byProvider[providerKey] ?? 0) + dayTokens;
      if (day.costUSD !== undefined) {
        accumulator.cost = (accumulator.cost ?? 0) + day.costUSD;
      }
    }
  }
  const all = [...byDate.values()];
  all.sort((a, b) => compareTopEntries(a, b, sort));
  return all.slice(0, limit);
}

function aggregateModels(
  dayMap: DayMap,
  providerKey: string,
  filter?: AggregateModelsFilter,
): ModelAccumulator[] {
  const byModel = aggregateModelsByDayMap(dayMap, filter);
  return [...byModel]
    .filter(([, agg]) => agg.inputTokens + agg.outputTokens > 0 || agg.hasCost)
    .map(([model, agg]) => ({
      providerKey,
      provider: providerLabel(providerKey),
      model,
      tokens: agg.inputTokens + agg.outputTokens,
      cost: agg.hasCost ? agg.costUSD : null,
      days: agg.days,
    }));
}

export function topModels(
  providerData: ProviderData,
  limit: number,
  sort: TopSort,
  filter?: AggregateModelsFilter,
): ModelAccumulator[] {
  const all: ModelAccumulator[] = [];
  for (const [providerKey, dayMap] of Object.entries(providerData)) {
    all.push(...aggregateModels(dayMap, providerKey, filter));
  }
  all.sort((a, b) => compareTopEntries(a, b, sort));
  return all.slice(0, limit);
}
