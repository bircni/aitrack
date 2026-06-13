import chalk from 'chalk';

import { sumDayMap } from '../data/aggregate.js';
import { filterProviderDataByYear } from '../data/dayMap.js';
import type { DayMap, ProviderData } from '../data/types.js';
import { fmt, fmtUSD } from './format.js';
import { mergeAllProviderDayMaps } from './heatmap/merge.js';
import { currentStreak, formatMonthLabel, longestStreak, peakMonth } from './heatmap/stats.js';
import { activeProviderKeys, providerLabel } from './providers.js';
import { defaultTableStyle, renderTerminalTable } from './terminalTable.js';

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

function summarizeDayMap(dayMap: DayMap, providerKey: string): StatsRow {
  const { inputTokens, outputTokens, costUSD, hasCost, days } = sumDayMap(dayMap);

  const cs = currentStreak(dayMap);
  const ls = longestStreak(dayMap);
  const peak = peakMonth(dayMap);

  return {
    provider: providerLabel(providerKey),
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

export function renderTui(providerData: ProviderData, opts: TuiOptions = {}): string {
  const filtered =
    opts.year === undefined ? providerData : filterProviderDataByYear(providerData, opts.year);

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

  const dark = Boolean(opts.dark);
  const title =
    opts.year === undefined
      ? chalk.bold('aitrack stats')
      : chalk.bold(`aitrack stats (${opts.year})`);
  const subtitle = chalk.dim('Streak = current / longest (days)');

  const bodyRows = rows.filter((r) => r.provider !== 'TOTAL');
  const footer = rows.find((r) => r.provider === 'TOTAL');

  const table = renderTerminalTable(
    rows,
    [
      { header: 'Provider', align: 'left', cell: (r) => r.provider },
      { header: 'Days', align: 'right', cell: (r) => String(r.days) },
      { header: 'Input', align: 'right', cell: (r) => r.input },
      { header: 'Output', align: 'right', cell: (r) => r.output },
      { header: 'Total', align: 'right', cell: (r) => r.total },
      { header: 'Est. cost', align: 'right', cell: (r) => r.cost },
      { header: 'Streak', align: 'right', cell: (r) => r.streak },
      { header: 'Peak month', align: 'left', cell: (r) => r.peak },
    ],
    {
      style: defaultTableStyle(dark),
      bodyRows,
      footerRow: footer,
      firstColumnStyle: defaultTableStyle(dark).header,
    },
  );

  return [title, subtitle, '', table].join('\n');
}
