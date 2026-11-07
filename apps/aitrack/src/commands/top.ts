import {
  isUsageNotConfigured,
  usageEmptyMessage,
  usageEmptyWindowMessage,
} from 'aitrack-lib/data/emptyState';
import {
  topDays,
  topModels,
  topProjects,
  topProviderKey,
  type TopSort,
  unpricedTopModels,
} from 'aitrack-lib/data/topUsage';
import { loadMergedProviderData } from 'aitrack-lib/data/usageData';
import { fmt, fmtUSDCost, unpricedFootnote } from 'aitrack-lib/display/format';
import { displayModelName } from 'aitrack-lib/display/modelNames';
import { renderTerminalTable, type TerminalTableColumn } from 'aitrack-lib/display/terminalTable';
import { log } from 'aitrack-lib/output';
import { warnAboutPricingFallbacks } from 'aitrack-lib/pricing/scan';
import { providerLabel } from 'aitrack-lib/providers/index';
import chalk from 'chalk';

import { UsageError } from '../cli/errors.js';
import { printEmptyResult, printJsonCommand } from '../cli/json.js';

export type TopKind = 'days' | 'models' | 'projects';

const PROJECTS_NOTE = 'Cursor usage is not attributed to projects and is not counted here.';

export interface TopOptions {
  kind: TopKind;
  limit: number;
  sort: TopSort;
  providers?: string[];
  refresh?: boolean;
  year?: number;
  /** Inclusive lower bound, YYYY-MM-DD. */
  since?: string;
  /** Inclusive upper bound, YYYY-MM-DD. */
  until?: string;
  json?: boolean;
}

function windowDescription({ year, since, until }: TopOptions): string | undefined {
  const parts: string[] = [];
  if (year !== undefined) parts.push(String(year));
  if (since !== undefined || until !== undefined) parts.push(`${since ?? '…'} → ${until ?? '…'}`);
  return parts.length === 0 ? undefined : parts.join(', ');
}

interface Row {
  rank: string;
  label: string;
  sub: string;
  tokens: string;
  cost: string;
}

/** One ranked kind; `json` holds each item's fields besides `rank`, in their published order. */
interface TopView<T> {
  noun: string;
  labelHeader: string;
  subHeader: string;
  items: T[];
  label: (item: T) => string;
  sub: (item: T) => string;
  json: (item: T) => Record<string, unknown>;
  unpriced?: string[];
  notes?: string[];
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

function renderTop<T extends { tokens: number; cost: number | null }>(
  options: TopOptions,
  view: TopView<T>,
): void {
  const { items, unpriced = [], notes = [] } = view;
  const window = windowDescription(options);
  const emptyMessage = items.length === 0 ? usageEmptyWindowMessage(window) : undefined;

  if (options.json) {
    printJsonCommand('top', {
      ...topJsonEnvelope(options),
      items: items.map((item, index) => ({ rank: index + 1, ...view.json(item) })),
      ...(unpriced.length > 0 && { unpricedModels: unpriced }),
      ...(notes.length > 0 && { notes }),
      ...(emptyMessage !== undefined && { message: emptyMessage }),
    });
    return;
  }

  if (emptyMessage !== undefined) {
    log.info(emptyMessage);
    return;
  }

  const columns: Array<TerminalTableColumn<Row>> = [
    { header: '#', align: 'right', cell: (r) => r.rank },
    { header: view.labelHeader, align: 'left', cell: (r) => r.label },
    { header: view.subHeader, align: 'left', cell: (r) => r.sub },
    { header: 'Tokens', align: 'right', cell: (r) => r.tokens },
    { header: 'Cost', align: 'right', cell: (r) => r.cost },
  ];
  const rows = items.map((item, index) => ({
    rank: String(index + 1),
    label: view.label(item),
    sub: view.sub(item),
    tokens: fmt(item.tokens),
    cost: item.cost === null ? '—' : fmtUSDCost(item.cost),
  }));
  const suffix = window === undefined ? '' : ` (${window})`;
  log.info(chalk.bold(`Top ${String(options.limit)} ${view.noun} by ${options.sort}${suffix}`));
  log.info(renderTerminalTable(rows, columns));
  const footnote = unpricedFootnote(unpriced);
  if (footnote !== null) log.info(chalk.dim(footnote));
  for (const note of notes) log.info(chalk.dim(note));
}

function topProviderName(byProvider: Record<string, number>): string {
  const key = topProviderKey(byProvider);
  return key ? providerLabel(key) : '';
}

export async function topCommand(options: TopOptions): Promise<void> {
  if (options.since !== undefined && options.until !== undefined && options.since > options.until) {
    throw new UsageError(
      `--since "${options.since}" must not be after --until "${options.until}".`,
    );
  }

  const loaded = await loadMergedProviderData({
    providers: options.providers,
    ...(options.refresh !== undefined && { refreshLive: options.refresh }),
  });

  if (!loaded) {
    printEmptyResult(
      'top',
      options.json,
      usageEmptyMessage(isUsageNotConfigured(), options.providers),
      {
        ...topJsonEnvelope(options),
        items: [],
      },
    );
    return;
  }

  warnAboutPricingFallbacks(loaded.providerData);

  const filter = { year: options.year, start: options.since, end: options.until };

  if (options.kind === 'days') {
    const items = topDays(loaded.providerData, options.limit, options.sort, filter);
    renderTop(options, {
      noun: 'days',
      labelHeader: 'Date',
      subHeader: 'Top provider',
      items,
      label: (d) => d.date,
      sub: (d) => topProviderName(d.byProvider),
      json: (d) => ({
        date: d.date,
        tokens: d.tokens,
        costUSD: d.cost,
        topProvider: topProviderKey(d.byProvider),
        byProvider: d.byProvider,
      }),
      unpriced: unpricedTopModels(items),
    });
    return;
  }

  if (options.kind === 'projects') {
    renderTop(options, {
      noun: 'projects',
      labelHeader: 'Project',
      subHeader: 'Top provider',
      items: topProjects(loaded.providerData, options.limit, options.sort, filter),
      label: (p) => p.project,
      sub: (p) => topProviderName(p.byProvider),
      json: (p) => ({
        project: p.project,
        unattributed: p.unattributed,
        tokens: p.tokens,
        costUSD: p.cost,
        topProvider: topProviderKey(p.byProvider),
        byProvider: p.byProvider,
      }),
      notes: [PROJECTS_NOTE],
    });
    return;
  }

  const items = topModels(loaded.providerData, options.limit, options.sort, filter);
  renderTop(options, {
    noun: 'models',
    labelHeader: 'Model',
    subHeader: 'Provider',
    items,
    label: (m) => displayModelName(m.model, { effort: true }),
    sub: (m) => m.provider,
    json: (m) => ({
      providerKey: m.providerKey,
      provider: m.provider,
      model: m.model,
      tokens: m.tokens,
      costUSD: m.cost,
      days: m.days,
    }),
    unpriced: unpricedTopModels(items),
  });
}
