import chalk from 'chalk';
import { loadMergedProviderData, emptyUsageMessage } from './show.js';
import { tryLoadConfig } from './config.js';
import { isCloned } from './git.js';
import { toLocalDateString } from './dayMap.js';
import type { DayMap } from './types.js';

export type UsagePeriod = 'today' | 'week' | 'month' | 'year' | 'all';

interface UsageOptions {
  period: UsagePeriod;
  noCursor?: boolean;
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

function pad(value: string, width: number, align: 'left' | 'right'): string {
  if (value.length >= width) return value;
  const padStr = ' '.repeat(width - value.length);
  return align === 'left' ? value + padStr : padStr + value;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  opencode: 'Open Code',
};
const PROVIDER_ORDER = ['claude_code', 'codex', 'cursor', 'gemini', 'opencode'];

interface Row {
  provider: string;
  tokens: string;
  model: string;
  price: string;
  isTotal?: boolean;
}

const COLUMNS: Array<{ key: keyof Row; header: string; align: 'left' | 'right' }> = [
  { key: 'provider', header: 'Provider', align: 'left' },
  { key: 'tokens', header: 'Tokens', align: 'right' },
  { key: 'model', header: 'Model', align: 'left' },
  { key: 'price', header: 'Price', align: 'right' },
];

function renderTable(rows: Row[]): string {
  const border = chalk.dim;
  const header = chalk.bold;
  const total = chalk.bold.cyan;

  const widths = COLUMNS.map((col) =>
    Math.max(col.header.length, ...rows.map((row) => String(row[col.key] ?? '').length)),
  );

  const hLine = (left: string, mid: string, right: string) =>
    border(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right);

  const renderRow = (cells: string[], style?: (text: string) => string) =>
    border('│') +
    cells
      .map((cell, i) => {
        const padded = pad(cell, widths[i], COLUMNS[i].align);
        return ` ${style ? style(padded) : padded} `;
      })
      .join(border('│')) +
    border('│');

  const lines: string[] = [];
  lines.push(hLine('┌', '┬', '┐'));
  lines.push(
    renderRow(
      COLUMNS.map((col) => col.header),
      header,
    ),
  );
  lines.push(hLine('├', '┼', '┤'));

  for (const row of rows.filter((r) => !r.isTotal)) {
    lines.push(renderRow(COLUMNS.map((col) => String(row[col.key] ?? ''))));
  }

  const totalRow = rows.find((r) => r.isTotal);
  if (totalRow) {
    lines.push(hLine('├', '┼', '┤'));
    lines.push(
      renderRow(
        COLUMNS.map((col) => String(totalRow[col.key] ?? '')),
        total,
      ),
    );
  }

  lines.push(hLine('└', '┴', '┘'));
  return lines.join('\n');
}

interface Window {
  start: string;
  end: string;
  label: string;
}

function computeWindow(period: UsagePeriod): Window {
  const today = new Date();
  const end = toLocalDateString(today);
  if (period === 'today') {
    return { start: end, end, label: `today (${end})` };
  }
  if (period === 'all') {
    return { start: '0000-01-01', end: '9999-12-31', label: 'all time' };
  }
  if (period === 'year') {
    const year = today.getFullYear();
    return { start: `${year}-01-01`, end: `${year}-12-31`, label: `${year}` };
  }
  const days = period === 'week' ? 7 : 30;
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - (days - 1));
  const start = toLocalDateString(startDate);
  return { start, end, label: `last ${days} days (${start} → ${end})` };
}

interface ModelAgg {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  hasCost: boolean;
}

function aggregateProvider(dayMap: DayMap, window: Window): Map<string, ModelAgg> {
  const byModel = new Map<string, ModelAgg>();
  for (const [date, day] of dayMap) {
    if (date < window.start || date > window.end) continue;
    for (const [model, counts] of Object.entries(day.byModel)) {
      let agg = byModel.get(model);
      if (!agg) {
        agg = { inputTokens: 0, outputTokens: 0, costUSD: 0, hasCost: false };
        byModel.set(model, agg);
      }
      agg.inputTokens += counts.inputTokens;
      agg.outputTokens += counts.outputTokens;
      if (counts.costUSD !== undefined) {
        agg.costUSD += counts.costUSD;
        agg.hasCost = true;
      }
    }
  }
  return byModel;
}

export async function usageCommand(opts: UsageOptions): Promise<void> {
  const loaded = await loadMergedProviderData({ noCursor: opts.noCursor });

  if (!loaded) {
    console.log(emptyUsageMessage(!tryLoadConfig() || !isCloned()));
    return;
  }

  const reportData = loaded.providerData;
  const window = computeWindow(opts.period);

  const ordered = [
    ...PROVIDER_ORDER.filter((k) => reportData[k]),
    ...Object.keys(reportData).filter((k) => !PROVIDER_ORDER.includes(k)),
  ];

  const rows: Row[] = [];
  let totTokens = 0;
  let totCost = 0;
  let anyCost = false;

  for (const key of ordered) {
    const dayMap = reportData[key];
    if (!dayMap) continue;
    const label = PROVIDER_LABELS[key] ?? key;
    const byModel = aggregateProvider(dayMap, window);
    const providerRows: Array<Row & { sortCost: number; sortTokens: number }> = [];
    for (const [model, agg] of byModel) {
      const tokens = agg.inputTokens + agg.outputTokens;
      if (tokens === 0 && !agg.hasCost) continue;
      providerRows.push({
        provider: label,
        tokens: fmt(tokens),
        model,
        price: agg.hasCost ? fmtUSD(agg.costUSD) : '—',
        sortCost: agg.hasCost ? agg.costUSD : 0,
        sortTokens: tokens,
      });
      totTokens += tokens;
      if (agg.hasCost) {
        totCost += agg.costUSD;
        anyCost = true;
      }
    }
    providerRows.sort((a, b) => b.sortCost - a.sortCost || b.sortTokens - a.sortTokens);
    for (const row of providerRows) {
      rows.push({ provider: row.provider, tokens: row.tokens, model: row.model, price: row.price });
    }
  }

  if (rows.length === 0) {
    console.log(`No usage recorded for ${window.label}.`);
    return;
  }

  rows.push({
    provider: 'TOTAL',
    tokens: fmt(totTokens),
    model: '',
    price: anyCost ? fmtUSD(totCost) : '—',
    isTotal: true,
  });

  console.log(chalk.bold(`aitrack usage ${window.label}`));
  console.log(renderTable(rows));
}
