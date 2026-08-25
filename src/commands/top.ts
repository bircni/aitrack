import chalk from 'chalk';

import { printJsonCommand } from '../cli/json.js';
import { aggregateModelsByDayMap } from '../data/aggregate.js';
import { isUsageNotConfigured } from '../data/emptyState.js';
import { compareByCostThenTokens } from '../data/sort.js';
import type { DayMap, ProviderData } from '../data/types.js';
import {
  loadMergedProviderData,
  usageEmptyMessage,
  usageEmptyWindowMessage,
} from '../data/usageData.js';
import { fmt, fmtUSD } from '../display/format.js';
import { providerLabel } from '../display/providers.js';
import {
  defaultTableStyle,
  renderTerminalTable,
  type TerminalTableColumn,
} from '../display/terminalTable.js';
import { log } from '../output.js';

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

interface TopSortable {
  tokens: number;
  cost: number | null;
}

interface DayEntryAccumulator extends TopSortable {
  date: string;
  byProvider: Record<string, number>;
}

interface ModelAccumulator extends TopSortable {
  providerKey: string;
  provider: string;
  model: string;
  days: number;
}

interface TopJsonItem {
  rank: number;
  tokens: number;
  costUSD: number | null;
  [key: string]: unknown;
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

function topProviderKey(byProvider: Record<string, number>): string | null {
  const top = Object.entries(byProvider).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
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
  all.sort((a, b) => compareTopEntries(a, b, sort));
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
  all.sort((a, b) => compareTopEntries(a, b, sort));
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

function renderTopOutput<T>(
  options: TopOptions,
  title: string,
  items: T[],
  toJsonItem: (item: T, index: number) => TopJsonItem,
  toRow: (item: T, index: number) => Row,
  columns: Array<TerminalTableColumn<Row>>,
): void {
  if (options.json) {
    printJsonCommand('top', {
      kind: options.kind,
      sort: options.sort,
      limit: options.limit,
      year: options.year ?? null,
      items: items.map((item, index) => toJsonItem(item, index)),
    });
    return;
  }

  if (items.length === 0) {
    log.info(usageEmptyWindowMessage());
    return;
  }

  const rows = items.map((item, index) => toRow(item, index));
  log.info(chalk.bold(title));
  log.info(renderTerminalTable(rows, columns, { style: defaultTableStyle() }));
}

export async function topCommand(options: TopOptions): Promise<void> {
  const loaded = await loadMergedProviderData({
    providers: options.providers,
    year: options.year,
  });

  if (!loaded) {
    const message = usageEmptyMessage(isUsageNotConfigured());
    if (options.json) {
      printJsonCommand('top', {
        kind: options.kind,
        sort: options.sort,
        limit: options.limit,
        year: options.year ?? null,
        items: [],
        message,
      });
    } else {
      log.info(message);
    }
    return;
  }

  const yearSuffix = options.year === undefined ? '' : ` (${String(options.year)})`;

  if (options.kind === 'days') {
    const items = topDays(loaded.providerData, options.limit, options.sort, options.year);
    renderTopOutput(
      options,
      `Top ${String(options.limit)} days by ${options.sort}${yearSuffix}`,
      items,
      (d, index) => ({
        rank: index + 1,
        date: d.date,
        tokens: d.tokens,
        costUSD: d.cost,
        topProvider: topProviderKey(d.byProvider),
        byProvider: d.byProvider,
      }),
      dayToRow,
      [
        { header: '#', align: 'right', cell: (r) => r.rank },
        { header: 'Date', align: 'left', cell: (r) => r.label },
        { header: 'Top provider', align: 'left', cell: (r) => r.sub },
        { header: 'Tokens', align: 'right', cell: (r) => r.tokens },
        { header: 'Cost', align: 'right', cell: (r) => r.cost },
      ],
    );
    return;
  }

  const items = topModels(loaded.providerData, options.limit, options.sort, options.year);
  renderTopOutput(
    options,
    `Top ${String(options.limit)} models by ${options.sort}${yearSuffix}`,
    items,
    (m, index) => ({
      rank: index + 1,
      providerKey: m.providerKey,
      provider: m.provider,
      model: m.model,
      tokens: m.tokens,
      costUSD: m.cost,
      days: m.days,
    }),
    modelToRow,
    [
      { header: '#', align: 'right', cell: (r) => r.rank },
      { header: 'Model', align: 'left', cell: (r) => r.label },
      { header: 'Provider', align: 'left', cell: (r) => r.sub },
      { header: 'Tokens', align: 'right', cell: (r) => r.tokens },
      { header: 'Cost', align: 'right', cell: (r) => r.cost },
    ],
  );
}
