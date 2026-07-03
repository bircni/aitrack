import type { DayMap } from './types.js';

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  hasCost: boolean;
  days: number;
}

export function sumDayMap(dayMap: DayMap): TokenTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUSD = 0;
  let hasCost = false;
  let days = 0;

  for (const day of dayMap.values()) {
    if (day.inputTokens + day.outputTokens > 0) days++;
    inputTokens += day.inputTokens;
    outputTokens += day.outputTokens;
    if (day.costUSD !== undefined) {
      costUSD += day.costUSD;
      hasCost = true;
    }
  }

  return { inputTokens, outputTokens, costUSD, hasCost, days };
}

export interface ModelAgg {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  hasCost: boolean;
  days: number;
}

export interface AggregateModelsFilter {
  start?: string;
  end?: string;
  year?: number;
}

function dateInFilter(date: string, filter?: AggregateModelsFilter): boolean {
  if (!filter) return true;
  if (filter.year !== undefined && !date.startsWith(`${String(filter.year)}-`)) return false;
  if (filter.start !== undefined && date < filter.start) return false;
  return filter.end === undefined || date <= filter.end;
}

export function aggregateModelsByDayMap(
  dayMap: DayMap,
  filter?: AggregateModelsFilter,
): Map<string, ModelAgg> {
  const byModel = new Map<string, ModelAgg>();
  for (const [date, day] of dayMap) {
    if (!dateInFilter(date, filter)) continue;
    for (const [model, counts] of Object.entries(day.byModel)) {
      const tokens = counts.inputTokens + counts.outputTokens;
      if (tokens === 0 && counts.costUSD === undefined) continue;
      let agg = byModel.get(model);
      if (!agg) {
        agg = { inputTokens: 0, outputTokens: 0, costUSD: 0, hasCost: false, days: 0 };
        byModel.set(model, agg);
      }
      agg.inputTokens += counts.inputTokens;
      agg.outputTokens += counts.outputTokens;
      agg.days++;
      if (counts.costUSD !== undefined) {
        agg.costUSD += counts.costUSD;
        agg.hasCost = true;
      }
    }
  }
  return byModel;
}
