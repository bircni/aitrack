import chalk from 'chalk';
import { loadMergedProviderData, emptyUsageMessage } from './show.js';
import { tryLoadConfig } from './config.js';
import { isCloned } from './git.js';
import { toLocalDateString } from './dayMap.js';
import type { DayMap } from './types.js';

interface TodayOptions {
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

export async function todayCommand(opts: TodayOptions = {}): Promise<void> {
  const loaded = await loadMergedProviderData({ noCursor: opts.noCursor });

  if (!loaded) {
    console.log(emptyUsageMessage(!tryLoadConfig() || !isCloned()));
    return;
  }

  const reportData = loaded.providerData;
  const today = toLocalDateString(new Date());

  const ordered = [
    ...PROVIDER_ORDER.filter((k) => reportData[k]),
    ...Object.keys(reportData).filter((k) => !PROVIDER_ORDER.includes(k)),
  ];

  const rows: Row[] = [];
  let totTokens = 0;
  let totCost = 0;
  let anyCost = false;

  for (const key of ordered) {
    const dayMap: DayMap | undefined = reportData[key];
    const day = dayMap?.get(today);
    if (!day) continue;
    const label = PROVIDER_LABELS[key] ?? key;
    for (const [model, counts] of Object.entries(day.byModel)) {
      const tokens = counts.inputTokens + counts.outputTokens;
      const hasCost = counts.costUSD !== undefined;
      rows.push({
        provider: label,
        tokens: fmt(tokens),
        model,
        price: hasCost ? fmtUSD(counts.costUSD ?? 0) : '—',
      });
      totTokens += tokens;
      if (hasCost) {
        totCost += counts.costUSD ?? 0;
        anyCost = true;
      }
    }
  }

  if (rows.length === 0) {
    console.log(`No usage recorded today (${today}).`);
    return;
  }

  rows.push({
    provider: 'TOTAL',
    tokens: fmt(totTokens),
    model: '',
    price: anyCost ? fmtUSD(totCost) : '—',
    isTotal: true,
  });

  console.log(chalk.bold(`aitrack today (${today})`));
  console.log(renderTable(rows));
}
