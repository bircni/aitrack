import chalk from 'chalk';

import { printJson } from '../cli/json.js';
import { tryLoadConfig } from '../config.js';
import { aggregateModelsByDayMap } from '../data/aggregate.js';
import type { DayMap, ProviderData } from '../data/types.js';
import { emptyUsageMessage, loadMergedProviderData } from '../data/usageData.js';
import { fmt, fmtUSD } from '../display/format.js';
import { providerLabel } from '../display/providers.js';
import { defaultTableStyle, renderTerminalTable } from '../display/terminalTable.js';
import { isCloned } from '../git.js';

export type TopKind = 'days' | 'models';
export type TopSort = 'tokens' | 'cost';

export interface TopOptions {
  kind: TopKind;
  limit: number;
  sort: TopSort;
  providers?: string[];
  year?: number;
  json?: boolean;
}

interface Row {
  rank: string;
  label: string;
  sub: string;
  tokens: string;
  cost: string;
}

interface DayEntryAccumulator {
  date: string;
  tokens: number;
  cost: number | null;
  byProvider: Record<string, number>;
}

interface ModelAccumulator {
  providerKey: string;
  provider: string;
  model: string;
  tokens: number;
  cost: number | null;
  days: number;
}

function topProviderKey(byProvider: Record<string, number>): string | null {
  const top = Object.entries(byProvider).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

function topJsonEnvelope(options: TopOptions, items: unknown[]): Record<string, unknown> {
  return {
    kind: options.kind,
    sort: options.sort,
    limit: options.limit,
    year: options.year ?? null,
    items,
  };
}

function topDays(
  providerData: ProviderData,
  limit: number,
  sort: TopSort,
  year?: number,
): DayEntryAccumulator[] {
  const byDate = new Map<string, DayEntryAccumulator>();
  for (const [providerKey, dayMap] of Object.entries(providerData)) {
    for (const [date, day] of dayMap) {
      if (year !== undefined && !date.startsWith(`${String(year)}-`)) continue;
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
  all.sort((a, b) =>
    sort === 'cost'
      ? (b.cost ?? 0) - (a.cost ?? 0) || b.tokens - a.tokens
      : b.tokens - a.tokens || (b.cost ?? 0) - (a.cost ?? 0),
  );
  return all.slice(0, limit);
}

function aggregateModels(dayMap: DayMap, providerKey: string, year?: number): ModelAccumulator[] {
  const byModel = aggregateModelsByDayMap(dayMap, { year });
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

function topModels(
  providerData: ProviderData,
  limit: number,
  sort: TopSort,
  year?: number,
): ModelAccumulator[] {
  const all: ModelAccumulator[] = [];
  for (const [providerKey, dayMap] of Object.entries(providerData)) {
    all.push(...aggregateModels(dayMap, providerKey, year));
  }
  all.sort((a, b) =>
    sort === 'cost'
      ? (b.cost ?? 0) - (a.cost ?? 0) || b.tokens - a.tokens
      : b.tokens - a.tokens || (b.cost ?? 0) - (a.cost ?? 0),
  );
  return all.slice(0, limit);
}

function dayToRow(d: DayEntryAccumulator, index: number): Row {
  const providerKey = topProviderKey(d.byProvider);
  return {
    rank: String(index + 1),
    label: d.date,
    sub: providerKey ? providerLabel(providerKey) : '',
    tokens: fmt(d.tokens),
    cost: fmtUSD(d.cost),
  };
}

function modelToRow(m: ModelAccumulator, index: number): Row {
  return {
    rank: String(index + 1),
    label: m.model,
    sub: m.provider,
    tokens: fmt(m.tokens),
    cost: fmtUSD(m.cost),
  };
}

export async function topCommand(options: TopOptions): Promise<void> {
  const loaded = await loadMergedProviderData({
    providers: options.providers,
    year: options.year,
  });

  if (!loaded) {
    console.log(emptyUsageMessage(!tryLoadConfig() || !isCloned()));
    return;
  }

  const yearSuffix = options.year === undefined ? '' : ` (${String(options.year)})`;

  if (options.kind === 'days') {
    const items = topDays(loaded.providerData, options.limit, options.sort, options.year);
    if (options.json) {
      printJson(
        topJsonEnvelope(
          options,
          items.map((d, index) => ({
            rank: index + 1,
            date: d.date,
            tokens: d.tokens,
            costUSD: d.cost,
            topProvider: topProviderKey(d.byProvider),
            byProvider: d.byProvider,
          })),
        ),
      );
      return;
    }
    if (items.length === 0) {
      console.log('No usage recorded.');
      return;
    }
    const rows = items.map(dayToRow);
    console.log(chalk.bold(`Top ${String(options.limit)} days by ${options.sort}${yearSuffix}`));
    console.log(
      renderTerminalTable(
        rows,
        [
          { header: '#', align: 'right', cell: (r) => r.rank },
          { header: 'Date', align: 'left', cell: (r) => r.label },
          { header: 'Top provider', align: 'left', cell: (r) => r.sub },
          { header: 'Tokens', align: 'right', cell: (r) => r.tokens },
          { header: 'Cost', align: 'right', cell: (r) => r.cost },
        ],
        { style: defaultTableStyle() },
      ),
    );
    return;
  }

  const items = topModels(loaded.providerData, options.limit, options.sort, options.year);
  if (options.json) {
    printJson(
      topJsonEnvelope(
        options,
        items.map((m, index) => ({
          rank: index + 1,
          providerKey: m.providerKey,
          provider: m.provider,
          model: m.model,
          tokens: m.tokens,
          costUSD: m.cost,
          days: m.days,
        })),
      ),
    );
    return;
  }
  if (items.length === 0) {
    console.log('No usage recorded.');
    return;
  }
  const rows = items.map(modelToRow);
  console.log(chalk.bold(`Top ${String(options.limit)} models by ${options.sort}${yearSuffix}`));
  console.log(
    renderTerminalTable(
      rows,
      [
        { header: '#', align: 'right', cell: (r) => r.rank },
        { header: 'Model', align: 'left', cell: (r) => r.label },
        { header: 'Provider', align: 'left', cell: (r) => r.sub },
        { header: 'Tokens', align: 'right', cell: (r) => r.tokens },
        { header: 'Cost', align: 'right', cell: (r) => r.cost },
      ],
      { style: defaultTableStyle() },
    ),
  );
}
