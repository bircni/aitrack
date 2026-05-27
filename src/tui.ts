import chalk from 'chalk';
import type { DayMap, ProviderData } from './types.js';
import { filterProviderDataByYear } from './dayMap.js';
import { loadMergedProviderData } from './show.js';
import {
  currentStreak,
  formatMonthLabel,
  longestStreak,
  mergeAllProviderDayMaps,
  peakMonth,
} from './render.js';

const PROVIDER_ORDER = ['claude_code', 'codex', 'cursor', 'gemini', 'opencode'];

const PROVIDER_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  opencode: 'Open Code',
  all: 'All providers',
};

export interface TuiOptions {
  dark?: boolean;
  noCursor?: boolean;
  all?: boolean;
  year?: number;
}

interface StatsRow {
  provider: string;
  days: number;
  input: string;
  output: string;
  total: string;
  cost: string;
  streak: string;
  peak: string;
  rawInput: number;
  rawOutput: number;
  rawCost: number | null;
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtUSD(n: number): string {
  if (n <= 0) return '—';
  if (n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function summarizeDayMap(dayMap: DayMap, providerKey: string): StatsRow {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUSD = 0;
  let hasCost = false;
  let days = 0;

  for (const day of dayMap.values()) {
    const total = day.inputTokens + day.outputTokens;
    if (total > 0) days++;
    inputTokens += day.inputTokens;
    outputTokens += day.outputTokens;
    if (day.costUSD !== undefined) {
      costUSD += day.costUSD;
      hasCost = true;
    }
  }

  const cs = currentStreak(dayMap);
  const ls = longestStreak(dayMap);
  const peak = peakMonth(dayMap);
  const name = PROVIDER_LABELS[providerKey] ?? providerKey;

  return {
    provider: name,
    days,
    input: fmt(inputTokens),
    output: fmt(outputTokens),
    total: fmt(inputTokens + outputTokens),
    cost: hasCost ? fmtUSD(costUSD) : '—',
    streak: `${cs} / ${ls}`,
    peak: peak ? formatMonthLabel(peak.month) : '—',
    rawInput: inputTokens,
    rawOutput: outputTokens,
    rawCost: hasCost ? costUSD : null,
  };
}

function totalRow(rows: StatsRow[]): StatsRow {
  let input = 0;
  let output = 0;
  let cost = 0;
  let hasCost = false;

  for (const row of rows) {
    input += row.rawInput;
    output += row.rawOutput;
    if (row.rawCost !== null) {
      hasCost = true;
      cost += row.rawCost;
    }
  }

  return {
    provider: 'TOTAL',
    days: rows.reduce((sum, row) => sum + row.days, 0),
    input: fmt(input),
    output: fmt(output),
    total: fmt(input + output),
    cost: hasCost ? fmtUSD(cost) : '—',
    streak: '—',
    peak: '—',
    rawInput: input,
    rawOutput: output,
    rawCost: hasCost ? cost : null,
  };
}

function pad(value: string, width: number, align: 'left' | 'right'): string {
  if (value.length >= width) return value;
  const padStr = ' '.repeat(width - value.length);
  return align === 'left' ? value + padStr : padStr + value;
}

function renderTable(rows: StatsRow[], dark: boolean): string {
  const color = {
    border: dark ? chalk.gray : chalk.dim,
    header: dark ? chalk.bold.white : chalk.bold,
    total: dark ? chalk.bold.cyan : chalk.bold,
  };

  const columns: Array<{ key: keyof StatsRow; header: string; align: 'left' | 'right' }> = [
    { key: 'provider', header: 'Provider', align: 'left' },
    { key: 'days', header: 'Days', align: 'right' },
    { key: 'input', header: 'Input', align: 'right' },
    { key: 'output', header: 'Output', align: 'right' },
    { key: 'total', header: 'Total', align: 'right' },
    { key: 'cost', header: 'Est. cost', align: 'right' },
    { key: 'streak', header: 'Streak', align: 'right' },
    { key: 'peak', header: 'Peak month', align: 'left' },
  ];

  const widths = columns.map((col) => {
    const cellWidths = rows.map((row) => String(row[col.key]).length);
    return Math.max(col.header.length, ...cellWidths);
  });

  const hLine = (left: string, mid: string, right: string) =>
    color.border(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right);

  const renderRow = (cells: string[], style?: (text: string) => string) =>
    color.border('│') +
    cells
      .map((cell, i) => {
        const col = columns[i];
        const padded = pad(cell, widths[i], col.align);
        const text = style && i === 0 ? style(padded) : padded;
        return ` ${text} `;
      })
      .join(color.border('│')) +
    color.border('│');

  const lines: string[] = [];
  lines.push(hLine('┌', '┬', '┐'));
  lines.push(
    renderRow(
      columns.map((col) => col.header),
      color.header,
    ),
  );
  lines.push(hLine('├', '┼', '┤'));

  for (const row of rows) {
    if (row.provider === 'TOTAL') continue;
    lines.push(
      renderRow(
        columns.map((col) => String(row[col.key])),
        color.header,
      ),
    );
  }

  if (rows.some((row) => row.provider === 'TOTAL')) {
    lines.push(hLine('├', '┼', '┤'));
    const total = rows.find((row) => row.provider === 'TOTAL');
    if (total) {
      lines.push(
        renderRow(
          columns.map((col) => String(total[col.key])),
          color.total,
        ),
      );
    }
  }

  lines.push(hLine('└', '┴', '┘'));
  return lines.join('\n');
}

function activeProviderKeys(providerData: ProviderData): string[] {
  const active = PROVIDER_ORDER.filter((k) => (providerData[k]?.size ?? 0) > 0);
  for (const k of Object.keys(providerData)) {
    if (!active.includes(k) && (providerData[k]?.size ?? 0) > 0) active.push(k);
  }
  return active;
}

export function renderTui(providerData: ProviderData, opts: TuiOptions = {}): string {
  const filtered =
    opts.year !== undefined ? filterProviderDataByYear(providerData, opts.year) : providerData;

  let rows: StatsRow[];
  if (opts.all) {
    const merged = mergeAllProviderDayMaps(filtered);
    rows = merged.size > 0 ? [summarizeDayMap(merged, 'all')] : [];
  } else {
    const keys = activeProviderKeys(filtered);
    rows = keys
      .map((key) => {
        const dayMap = filtered[key];
        return dayMap ? summarizeDayMap(dayMap, key) : null;
      })
      .filter((row): row is StatsRow => row !== null);
    if (rows.length > 1) rows.push(totalRow(rows));
  }

  if (rows.length === 0) return '';

  const title =
    opts.year !== undefined
      ? chalk.bold(`aitrack stats (${opts.year})`)
      : chalk.bold('aitrack stats');
  const subtitle = chalk.dim('Streak = current / longest (days)');

  return [title, subtitle, '', renderTable(rows, Boolean(opts.dark))].join('\n');
}

export async function tuiCommand(opts: TuiOptions = {}): Promise<void> {
  const loaded = await loadMergedProviderData({
    noCursor: opts.noCursor,
    year: opts.year,
  });

  if (!loaded) {
    console.log(
      'No usage data found. Run: npx aitrack sync (Claude/Codex), or use Cursor locally.',
    );
    return;
  }

  const output = renderTui(loaded.providerData, opts);
  if (!output) {
    console.log('No usage data found.');
    return;
  }

  console.log(output);
}
