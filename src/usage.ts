import chalk from 'chalk';

import { tryLoadConfig } from './config.js';
import { toLocalDateString } from './dayMap.js';
import { isCloned } from './git.js';
import { emptyUsageMessage, loadMergedProviderData } from './show.js';
import type { DayMap } from './types.js';

type UsagePeriod =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'month'
  | 'year'
  | 'all'
  | 'thisweek'
  | 'lastweek'
  | 'thismonth'
  | 'lastmonth'
  | 'date'
  | 'range'
  | 'last';

export interface UsageOptions {
  period: UsagePeriod;
  noCursor?: boolean;
  /** ISO date (YYYY-MM-DD) for 'date' period, or range start for 'range' */
  from?: string;
  /** ISO date (YYYY-MM-DD) range end for 'range' */
  to?: string;
  /** Number of days for 'last' period */
  n?: number;
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
        // i is always within bounds — cells.length === COLUMNS.length by construction.
        const padded = pad(cell, widths[i] ?? 0, COLUMNS[i]?.align ?? 'left');
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

function computeWindow(opts: UsageOptions): Window {
  const today = new Date();
  const todayStr = toLocalDateString(today);

  switch (opts.period) {
    case 'today': {
      const localDate = today.toLocaleDateString();
      const localTime = today.toLocaleTimeString();
      return { start: todayStr, end: todayStr, label: `today (${localDate} ${localTime})` };
    }

    case 'yesterday': {
      const d = new Date(today);
      d.setDate(d.getDate() - 1);
      const s = toLocalDateString(d);
      return { start: s, end: s, label: `yesterday (${s})` };
    }

    case 'date': {
      if (!opts.from) throw new Error('from is required for date period');
      return { start: opts.from, end: opts.from, label: opts.from };
    }

    case 'range': {
      if (!opts.from || !opts.to) throw new Error('from and to are required for range period');
      return { start: opts.from, end: opts.to, label: `${opts.from} → ${opts.to}` };
    }

    case 'thisweek': {
      const daysFromMon = (today.getDay() + 6) % 7;
      const mon = new Date(today);
      mon.setDate(today.getDate() - daysFromMon);
      const start = toLocalDateString(mon);
      return { start, end: todayStr, label: `this week (${start} → ${todayStr})` };
    }

    case 'lastweek': {
      const daysFromMon = (today.getDay() + 6) % 7;
      const thisMon = new Date(today);
      thisMon.setDate(today.getDate() - daysFromMon);
      const lastSun = new Date(thisMon);
      lastSun.setDate(thisMon.getDate() - 1);
      const lastMon = new Date(thisMon);
      lastMon.setDate(thisMon.getDate() - 7);
      const start = toLocalDateString(lastMon);
      const end = toLocalDateString(lastSun);
      return { start, end, label: `last week (${start} → ${end})` };
    }

    case 'thismonth': {
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, '0');
      const start = `${y}-${m}-01`;
      return { start, end: todayStr, label: `this month (${start} → ${todayStr})` };
    }

    case 'lastmonth': {
      const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
      const start = toLocalDateString(firstDay);
      const end = toLocalDateString(lastDay);
      return { start, end, label: `last month (${start} → ${end})` };
    }

    case 'last': {
      if (!opts.n) throw new Error('n is required for last period');
      const d = new Date(today);
      d.setDate(today.getDate() - (opts.n - 1));
      const start = toLocalDateString(d);
      return { start, end: todayStr, label: `last ${opts.n} days (${start} → ${todayStr})` };
    }

    case 'week': {
      const d = new Date(today);
      d.setDate(today.getDate() - 6);
      const start = toLocalDateString(d);
      return { start, end: todayStr, label: `last 7 days (${start} → ${todayStr})` };
    }

    case 'month': {
      const d = new Date(today);
      d.setDate(today.getDate() - 29);
      const start = toLocalDateString(d);
      return { start, end: todayStr, label: `last 30 days (${start} → ${todayStr})` };
    }

    case 'year': {
      const year = today.getFullYear();
      return { start: `${year}-01-01`, end: `${year}-12-31`, label: `${year}` };
    }

    case 'all':
      return { start: '0000-01-01', end: '9999-12-31', label: 'all time' };
  }
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
  const window = computeWindow(opts);

  const ordered = [
    ...PROVIDER_ORDER.filter((k) => reportData[k]),
    ...Object.keys(reportData).filter((k) => !PROVIDER_ORDER.includes(k)),
  ];

  const rows: Row[] = [];
  let totInput = 0;
  let totOutput = 0;
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
      totInput += agg.inputTokens;
      totOutput += agg.outputTokens;
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
    tokens: fmt(totInput + totOutput),
    model: '',
    price: anyCost ? fmtUSD(totCost) : '—',
    isTotal: true,
  });

  console.log(chalk.bold(`aitrack usage ${window.label}`));
  console.log(renderTable(rows));
}
