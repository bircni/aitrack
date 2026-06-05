import chalk from 'chalk';

import { tryLoadConfig } from './config.js';
import { isCloned } from './git.js';
import { emptyUsageMessage, loadMergedProviderData } from './show.js';
import type { MachineFile } from './types.js';

interface MachineSummary {
  hostname: string;
  lastUpdated: string;
  days: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number | null;
  providers: string[];
  firstDay: string | null;
  lastDay: string | null;
}

const PROVIDER_LABELS = new Map<string, string>([
  ['claude_code', 'Claude Code'],
  ['codex', 'Codex'],
  ['cursor', 'Cursor'],
  ['gemini', 'Gemini'],
  ['opencode', 'Open Code'],
]);

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

function summarizeMachine(file: MachineFile): MachineSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUSD = 0;
  let hasCost = false;
  const providers = new Set<string>();
  const dayKeys: string[] = [];

  for (const [date, dayProviders] of Object.entries(file.days)) {
    let dayHasTokens = false;
    for (const [providerKey, pData] of Object.entries(dayProviders)) {
      providers.add(providerKey);
      inputTokens += pData.totals.inputTokens;
      outputTokens += pData.totals.outputTokens;
      if (pData.totals.costUSD !== undefined) {
        costUSD += pData.totals.costUSD;
        hasCost = true;
      }
      if (pData.totals.inputTokens + pData.totals.outputTokens > 0) dayHasTokens = true;
    }
    if (dayHasTokens) dayKeys.push(date);
  }
  dayKeys.sort();
  return {
    hostname: file.hostname,
    lastUpdated: file.lastUpdated,
    days: dayKeys.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUSD: hasCost ? costUSD : null,
    providers: [...providers].sort((a, b) => {
      const labels = [...PROVIDER_LABELS.keys()];
      const ai = labels.indexOf(a);
      const bi = labels.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }),
    firstDay: dayKeys[0] ?? null,
    lastDay: dayKeys[dayKeys.length - 1] ?? null,
  };
}

function providerListLabel(providers: string[]): string {
  return providers.map((p) => PROVIDER_LABELS.get(p) ?? p).join(', ');
}

function renderTable(rows: MachineSummary[]): string {
  const border = chalk.dim;
  const header = chalk.bold;

  interface Cell {
    value: string;
    align: 'left' | 'right';
  }
  const headers: Cell[] = [
    { value: 'Machine', align: 'left' },
    { value: 'Days', align: 'right' },
    { value: 'Tokens', align: 'right' },
    { value: 'Cost', align: 'right' },
    { value: 'Last sync', align: 'left' },
    { value: 'Providers', align: 'left' },
  ];

  const dataRows: Cell[][] = rows.map((m) => [
    { value: m.hostname, align: 'left' },
    { value: String(m.days), align: 'right' },
    { value: fmt(m.totalTokens), align: 'right' },
    { value: fmtUSD(m.costUSD), align: 'right' },
    { value: m.lastUpdated.slice(0, 10), align: 'left' },
    { value: providerListLabel(m.providers), align: 'left' },
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.value.length, ...dataRows.map((row) => row[i].value.length)),
  );

  const hLine = (left: string, mid: string, right: string) =>
    border(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right);

  const renderRow = (cells: Cell[], style?: (text: string) => string) =>
    border('│') +
    cells
      .map((cell, i) => {
        const padded = pad(cell.value, widths[i], cell.align);
        return ` ${style ? style(padded) : padded} `;
      })
      .join(border('│')) +
    border('│');

  const lines: string[] = [];
  lines.push(hLine('┌', '┬', '┐'));
  lines.push(renderRow(headers, header));
  lines.push(hLine('├', '┼', '┤'));
  for (const row of dataRows) {
    lines.push(renderRow(row));
  }
  lines.push(hLine('└', '┴', '┘'));
  return lines.join('\n');
}

export async function machinesCommand(): Promise<void> {
  const loaded = await loadMergedProviderData({ noCursor: true });

  if (!loaded || loaded.machineData.length === 0) {
    console.log(emptyUsageMessage(!tryLoadConfig() || !isCloned()));
    return;
  }

  const summaries = loaded.machineData
    .map(summarizeMachine)
    .sort((a, b) => b.totalTokens - a.totalTokens);

  console.log(chalk.bold(`aitrack machines (${String(summaries.length)})`));
  console.log(renderTable(summaries));
}
