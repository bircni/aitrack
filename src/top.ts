import chalk from 'chalk';

import { tryLoadConfig } from './config.js';
import { isCloned } from './git.js';
import { emptyUsageMessage, loadMergedProviderData } from './show.js';
import type { DayMap, ProviderData } from './types.js';

const PROVIDER_LABELS = new Map<string, string>([
  ['claude_code', 'Claude Code'],
  ['codex', 'Codex'],
  ['cursor', 'Cursor'],
  ['gemini', 'Gemini'],
  ['opencode', 'Open Code'],
]);

function providerLabel(providerKey: string): string {
  return PROVIDER_LABELS.get(providerKey) ?? providerKey;
}

export type TopKind = 'days' | 'models';
export type TopSort = 'tokens' | 'cost';

export interface TopOptions {
  kind: TopKind;
  limit: number;
  sort: TopSort;
  noCursor?: boolean;
  year?: number;
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtUSD(n: number | null): string {
  if (n === null || n <= 0) return '—';
  if (n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pad(value: string, width: number, align: 'left' | 'right'): string {
  if (value.length >= width) return value;
  const padStr = ' '.repeat(width - value.length);
  return align === 'left' ? value + padStr : padStr + value;
}

interface Row {
  rank: string;
  label: string;
  sub: string;
  tokens: string;
  cost: string;
}

function renderTable(rows: Row[], headers: { label: string; sub: string }): string {
  const border = chalk.dim;
  const header = chalk.bold;

  const columns: Array<{ key: keyof Row; header: string; align: 'left' | 'right' }> = [
    { key: 'rank', header: '#', align: 'right' },
    { key: 'label', header: headers.label, align: 'left' },
    { key: 'sub', header: headers.sub, align: 'left' },
    { key: 'tokens', header: 'Tokens', align: 'right' },
    { key: 'cost', header: 'Cost', align: 'right' },
  ];

  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((row) => row[col.key].length)),
  );

  const hLine = (left: string, mid: string, right: string) =>
    border(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right);

  const renderRow = (cells: string[], style?: (text: string) => string) =>
    border('│') +
    cells
      .map((cell, i) => {
        const padded = pad(cell, widths[i], columns[i].align);
        return ` ${style ? style(padded) : padded} `;
      })
      .join(border('│')) +
    border('│');

  const lines: string[] = [];
  lines.push(hLine('┌', '┬', '┐'));
  lines.push(
    renderRow(
      columns.map((c) => c.header),
      header,
    ),
  );
  lines.push(hLine('├', '┼', '┤'));
  for (const row of rows) {
    lines.push(renderRow(columns.map((c) => row[c.key])));
  }
  lines.push(hLine('└', '┴', '┘'));
  return lines.join('\n');
}

interface DayEntryAcc {
  date: string;
  tokens: number;
  cost: number | null;
  byProvider: Record<string, number>;
}

function topDays(
  providerData: ProviderData,
  limit: number,
  sort: TopSort,
  year?: number,
): DayEntryAcc[] {
  const byDate = new Map<string, DayEntryAcc>();
  for (const [providerKey, dayMap] of Object.entries(providerData)) {
    for (const [date, day] of dayMap) {
      if (year !== undefined && !date.startsWith(`${String(year)}-`)) continue;
      let acc = byDate.get(date);
      if (!acc) {
        acc = { date, tokens: 0, cost: null, byProvider: {} };
        byDate.set(date, acc);
      }
      const dayTokens = day.inputTokens + day.outputTokens;
      acc.tokens += dayTokens;
      acc.byProvider[providerKey] = (acc.byProvider[providerKey] ?? 0) + dayTokens;
      if (day.costUSD !== undefined) {
        acc.cost = (acc.cost ?? 0) + day.costUSD;
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

interface ModelAcc {
  providerKey: string;
  provider: string;
  model: string;
  tokens: number;
  cost: number | null;
  days: number;
}

function aggregateModels(dayMap: DayMap, providerKey: string, year?: number): ModelAcc[] {
  const byModel = new Map<string, ModelAcc>();
  for (const [date, day] of dayMap) {
    if (year !== undefined && !date.startsWith(`${String(year)}-`)) continue;
    for (const [model, counts] of Object.entries(day.byModel)) {
      const tokens = counts.inputTokens + counts.outputTokens;
      if (tokens === 0 && counts.costUSD === undefined) continue;
      let acc = byModel.get(model);
      if (!acc) {
        acc = {
          providerKey,
          provider: providerLabel(providerKey),
          model,
          tokens: 0,
          cost: null,
          days: 0,
        };
        byModel.set(model, acc);
      }
      acc.tokens += tokens;
      acc.days++;
      if (counts.costUSD !== undefined) {
        acc.cost = (acc.cost ?? 0) + counts.costUSD;
      }
    }
  }
  return [...byModel.values()];
}

function topModels(
  providerData: ProviderData,
  limit: number,
  sort: TopSort,
  year?: number,
): ModelAcc[] {
  const all: ModelAcc[] = [];
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

export async function topCommand(opts: TopOptions): Promise<void> {
  const loaded = await loadMergedProviderData({
    noCursor: opts.noCursor,
    year: opts.year,
  });

  if (!loaded) {
    console.log(emptyUsageMessage(!tryLoadConfig() || !isCloned()));
    return;
  }

  if (opts.kind === 'days') {
    const items = topDays(loaded.providerData, opts.limit, opts.sort, opts.year);
    if (items.length === 0) {
      console.log('No usage recorded.');
      return;
    }
    const rows: Row[] = items.map((d, i) => {
      const topProvider = Object.entries(d.byProvider).sort((a, b) => b[1] - a[1])[0];
      const topProviderLabel = topProvider ? providerLabel(topProvider[0]) : '';
      return {
        rank: String(i + 1),
        label: d.date,
        sub: topProviderLabel,
        tokens: fmt(d.tokens),
        cost: fmtUSD(d.cost),
      };
    });
    const yearSuffix = opts.year === undefined ? '' : ` (${String(opts.year)})`;
    console.log(chalk.bold(`Top ${String(opts.limit)} days by ${opts.sort}${yearSuffix}`));
    console.log(renderTable(rows, { label: 'Date', sub: 'Top provider' }));
    return;
  }

  // models
  const items = topModels(loaded.providerData, opts.limit, opts.sort, opts.year);
  if (items.length === 0) {
    console.log('No usage recorded.');
    return;
  }
  const rows: Row[] = items.map((m, i) => ({
    rank: String(i + 1),
    label: m.model,
    sub: m.provider,
    tokens: fmt(m.tokens),
    cost: fmtUSD(m.cost),
  }));
  const yearSuffix = opts.year === undefined ? '' : ` (${String(opts.year)})`;
  console.log(chalk.bold(`Top ${String(opts.limit)} models by ${opts.sort}${yearSuffix}`));
  console.log(renderTable(rows, { label: 'Model', sub: 'Provider' }));
}
