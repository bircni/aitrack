import { providerLabel } from '../providers/index.js';
import {
  type AggregateModelsFilter,
  aggregateModelsByDayMap,
  dateInFilter,
  hasUnpricedUsage,
} from './aggregate.js';
import { aggregateProjects, type ProjectUsage } from './projectUsage.js';
import { compareByCostThenTokens } from './sort.js';
import type { DayMap, ProviderData } from './types.js';

/** Ranking days and models by tokens or cost. */
export type TopSort = 'tokens' | 'cost';

interface TopSortable {
  tokens: number;
  cost: number | null;
}

export interface DayEntryAccumulator extends TopSortable {
  date: string;
  byProvider: Record<string, number>;
  unpricedModels: string[];
}

export interface ModelAccumulator extends TopSortable {
  providerKey: string;
  provider: string;
  model: string;
  days: number;
  hasUnpricedTokens: boolean;
}

function compareTopEntries(a: TopSortable, b: TopSortable, sort: TopSort): number {
  if (sort === 'tokens') {
    return b.tokens - a.tokens || (b.cost ?? 0) - (a.cost ?? 0);
  }
  return compareByCostThenTokens(a, b);
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
        accumulator = { date, tokens: 0, cost: null, byProvider: {}, unpricedModels: [] };
        byDate.set(date, accumulator);
      }
      const dayTokens = day.inputTokens + day.outputTokens;
      accumulator.tokens += dayTokens;
      accumulator.byProvider[providerKey] = (accumulator.byProvider[providerKey] ?? 0) + dayTokens;
      for (const [model, counts] of Object.entries(day.byModel)) {
        if (hasUnpricedUsage(counts) && !accumulator.unpricedModels.includes(model)) {
          accumulator.unpricedModels.push(model);
        }
      }
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
  return [...aggregateModelsByDayMap(dayMap, filter)].map(([model, agg]) => ({
    providerKey,
    provider: providerLabel(providerKey),
    model,
    tokens: agg.inputTokens + agg.outputTokens,
    cost: agg.hasCost ? agg.costUSD : null,
    days: agg.days,
    hasUnpricedTokens: agg.hasUnpricedTokens === true,
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

export interface ProjectAccumulator extends TopSortable {
  project: string;
  /** The remainder with no project, ranked like the rest so it is not hidden. */
  unattributed: boolean;
  hasUnpricedTokens: boolean;
  byProvider: Record<string, number>;
}

function toProjectAccumulator(usage: ProjectUsage): ProjectAccumulator {
  return {
    project: usage.project,
    unattributed: usage.unattributed === true,
    tokens: usage.tokens,
    cost: usage.hasCost ? usage.costUSD : null,
    hasUnpricedTokens: usage.hasUnpricedTokens === true,
    byProvider: Object.fromEntries(usage.providers.map((entry) => [entry.key, entry.tokens])),
  };
}

export function topProjects(
  providerData: ProviderData,
  limit: number,
  sort: TopSort,
  filter?: AggregateModelsFilter,
): ProjectAccumulator[] {
  const { projects, unattributed } = aggregateProjects(providerData, filter);
  return [...projects, ...(unattributed ? [unattributed] : [])]
    .map((usage) => toProjectAccumulator(usage))
    .toSorted((a, b) => compareTopEntries(a, b, sort))
    .slice(0, limit);
}

export function unpricedTopModels(
  entries: ReadonlyArray<DayEntryAccumulator | ModelAccumulator>,
): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    if ('unpricedModels' in entry) for (const model of entry.unpricedModels) names.add(model);
    else if (entry.hasUnpricedTokens) names.add(entry.model);
  }
  return [...names].toSorted();
}
