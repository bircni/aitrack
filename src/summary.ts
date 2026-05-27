import { loadConfig } from './config.js';
import { isCloned, listDataFiles, pull, readDataFile } from './git.js';
import { readCursorData } from './readers/cursor.js';
import type { DayMap, ProviderData } from './types.js';
import { getOrCreateDay, filterProviderDataByYear } from './dayMap.js';
import { mergeProviderDay } from './show.js';

interface SummaryOptions {
  noCursor?: boolean;
  noPull?: boolean;
  year?: number;
}

interface MonthBucket {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  hasCost: boolean;
  days: number;
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtUSD(n: number): string {
  if (n === 0) return '—';
  if (n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function bucketByMonth(dayMap: DayMap): Map<string, MonthBucket> {
  const months = new Map<string, MonthBucket>();
  for (const [date, day] of dayMap) {
    const m = date.slice(0, 7);
    let b = months.get(m);
    if (!b) {
      b = { inputTokens: 0, outputTokens: 0, costUSD: 0, hasCost: false, days: 0 };
      months.set(m, b);
    }
    b.inputTokens += day.inputTokens;
    b.outputTokens += day.outputTokens;
    if (day.costUSD !== undefined) {
      b.costUSD += day.costUSD;
      b.hasCost = true;
    }
    if (day.inputTokens + day.outputTokens > 0) b.days += 1;
  }
  return months;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function printProvider(name: string, dayMap: DayMap): void {
  const months = [...bucketByMonth(dayMap).entries()].sort(([a], [b]) => a.localeCompare(b));
  if (months.length === 0) return;

  console.log(`\n${name}`);
  console.log(
    `  ${pad('Month', 8)} ${padLeft('Days', 5)} ${padLeft('Input', 9)} ${padLeft('Output', 9)} ${padLeft('Cost', 11)}`,
  );

  let totIn = 0;
  let totOut = 0;
  let totCost = 0;
  let anyCost = false;
  let totDays = 0;
  for (const [month, b] of months) {
    console.log(
      `  ${pad(month, 8)} ${padLeft(String(b.days), 5)} ${padLeft(fmt(b.inputTokens), 9)} ${padLeft(fmt(b.outputTokens), 9)} ${padLeft(b.hasCost ? fmtUSD(b.costUSD) : '—', 11)}`,
    );
    totIn += b.inputTokens;
    totOut += b.outputTokens;
    totCost += b.costUSD;
    anyCost = anyCost || b.hasCost;
    totDays += b.days;
  }
  console.log(
    `  ${pad('TOTAL', 8)} ${padLeft(String(totDays), 5)} ${padLeft(fmt(totIn), 9)} ${padLeft(fmt(totOut), 9)} ${padLeft(anyCost ? fmtUSD(totCost) : '—', 11)}`,
  );
}

export async function summaryCommand(opts: SummaryOptions = {}): Promise<void> {
  loadConfig();

  if (!isCloned()) {
    throw new Error('Repo not cloned. Run: npx aitrack init');
  }

  if (!opts.noPull) {
    console.log('Pulling latest from remote...');
    pull();
  }

  const machineData = listDataFiles()
    .map(readDataFile)
    .filter((data): data is MachineFile => data !== null);
  const providers: ProviderData = {};
  for (const data of machineData) {
    for (const [date, providerData] of Object.entries(data.days)) {
      for (const [providerKey, pData] of Object.entries(providerData)) {
        if (providerKey === 'cursor') continue;
        const dayMap = (providers[providerKey] ??= new Map());
        mergeProviderDay(getOrCreateDay(dayMap, date), providerKey, pData, date);
      }
    }
  }

  if (!opts.noCursor) {
    const cursorMap = await readCursorData();
    if (cursorMap.size > 0) providers.cursor = cursorMap;
  }

  const reportData =
    opts.year !== undefined ? filterProviderDataByYear(providers, opts.year) : providers;

  if (Object.keys(reportData).length === 0) {
    console.log('No usage data found.');
    return;
  }

  const labels: Record<string, string> = {
    claude_code: 'Claude Code',
    codex: 'Codex',
    cursor: 'Cursor',
    gemini: 'Gemini',
    opencode: 'Open Code',
  };
  const order = ['claude_code', 'codex', 'cursor', 'gemini', 'opencode'];
  const ordered = [
    ...order.filter((k) => reportData[k]),
    ...Object.keys(reportData).filter((k) => !order.includes(k)),
  ];
  for (const key of ordered) {
    const dayMap = reportData[key];
    if (dayMap) printProvider(labels[key] ?? key, dayMap);
  }
}
