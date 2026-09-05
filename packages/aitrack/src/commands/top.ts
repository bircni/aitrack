import type { AggregateModelsFilter } from 'aitrack-lib/data/aggregate';
import { isUsageNotConfigured } from 'aitrack-lib/data/emptyState';
import {
  type DayEntryAccumulator,
  type ModelAccumulator,
  topDays,
  topModels,
  topProviderKey,
  type TopSort,
} from 'aitrack-lib/data/topUsage';
import {
  loadMergedProviderData,
  usageEmptyMessage,
  usageEmptyWindowMessage,
} from 'aitrack-lib/data/usageData';
import { fmt, fmtUSD } from 'aitrack-lib/display/format';
import { providerLabel } from 'aitrack-lib/display/providers';
import {
  defaultTableStyle,
  renderTerminalTable,
  type TerminalTableColumn,
} from 'aitrack-lib/display/terminalTable';
import { log } from 'aitrack-lib/output';
import chalk from 'chalk';

import { printJsonCommand } from '../cli/json.js';

export type TopKind = 'days' | 'models';
export type { TopSort } from 'aitrack-lib/data/topUsage';

export interface TopOptions {
  kind: TopKind;
  limit: number;
  sort: TopSort;
  providers?: string[];
  /** Re-fetch live provider data (Cursor) instead of serving the local cache. */
  refresh?: boolean;
  year?: number;
  /** Inclusive lower bound, YYYY-MM-DD. */
  since?: string;
  /** Inclusive upper bound, YYYY-MM-DD. */
  until?: string;
  json?: boolean;
}

function dateFilter(options: TopOptions): AggregateModelsFilter | undefined {
  if (options.year === undefined && options.since === undefined && options.until === undefined) {
    return undefined;
  }
  return { year: options.year, start: options.since, end: options.until };
}

function windowSuffix(options: TopOptions): string {
  if (options.since !== undefined || options.until !== undefined) {
    return ` (${options.since ?? '…'} → ${options.until ?? '…'})`;
  }
  return options.year === undefined ? '' : ` (${String(options.year)})`;
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

function topJsonEnvelope(options: TopOptions): Record<string, unknown> {
  return {
    kind: options.kind,
    sort: options.sort,
    limit: options.limit,
    year: options.year ?? null,
    since: options.since ?? null,
    until: options.until ?? null,
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
      ...topJsonEnvelope(options),
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
  if (options.since !== undefined && options.until !== undefined && options.since > options.until) {
    throw new Error(`--since "${options.since}" must not be after --until "${options.until}".`);
  }

  const loaded = await loadMergedProviderData({
    providers: options.providers,
    ...(options.refresh !== undefined && { refreshLive: options.refresh }),
    // Skip the load-time year prune when an explicit range is set: the range,
    // not the calendar year, is what bounds the result.
    year: options.since === undefined && options.until === undefined ? options.year : undefined,
  });

  if (!loaded) {
    const message = usageEmptyMessage(isUsageNotConfigured());
    if (options.json) {
      printJsonCommand('top', { ...topJsonEnvelope(options), items: [], message });
    } else {
      log.info(message);
    }
    return;
  }

  const filter = dateFilter(options);
  const suffix = windowSuffix(options);

  if (options.kind === 'days') {
    const items = topDays(loaded.providerData, options.limit, options.sort, filter);
    renderTopOutput(
      options,
      `Top ${String(options.limit)} days by ${options.sort}${suffix}`,
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

  const items = topModels(loaded.providerData, options.limit, options.sort, filter);
  renderTopOutput(
    options,
    `Top ${String(options.limit)} models by ${options.sort}${suffix}`,
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
