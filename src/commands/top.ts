import chalk from 'chalk';

import { printJsonCommand } from '../cli/json.js';
import { isUsageNotConfigured } from '../data/emptyState.js';
import {
  type DayEntryAccumulator,
  type ModelAccumulator,
  topDays,
  topModels,
  topProviderKey,
  type TopSort,
} from '../data/topUsage.js';
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
export type { TopSort } from '../data/topUsage.js';

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

interface TopJsonItem {
  rank: number;
  tokens: number;
  costUSD: number | null;
  [key: string]: unknown;
}

/** The two tables differ only in these two headings. */
function topColumns(labelHeader: string, subHeader: string): Array<TerminalTableColumn<Row>> {
  return [
    { header: '#', align: 'right', cell: (r) => r.rank },
    { header: labelHeader, align: 'left', cell: (r) => r.label },
    { header: subHeader, align: 'left', cell: (r) => r.sub },
    { header: 'Tokens', align: 'right', cell: (r) => r.tokens },
    { header: 'Cost', align: 'right', cell: (r) => r.cost },
  ];
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
      topColumns('Date', 'Top provider'),
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
    topColumns('Model', 'Provider'),
  );
}
