import chalk from 'chalk';

import { sumDayMap } from '../data/aggregate.js';
import type { DayMap, ProviderData } from '../data/types.js';
import { fmt, fmtUSD } from './format.js';
import { resolveProviderLayout } from './heatmap/layout.js';
import { currentStreak, formatMonthLabel, longestStreak, peakMonth } from './heatmap/stats.js';
import { providerLabel } from './providers.js';
import { defaultTableStyle, renderTerminalTable } from './terminalTable.js';

export interface TuiOptions {
  dark?: boolean;
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

function totalRow(rows: StatsRow[], dayMaps: DayMap[]): StatsRow {
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

  // Days are calendar dates, not a per-provider tally: a date on which two
  // providers were both active is still one day. Summing the provider counts
  // would report a month of daily two-provider usage as ~60 days, and would
  // disagree with --all, which counts unique dates off the merged map.
  const activeDates = new Set<string>();
  for (const dayMap of dayMaps) {
    for (const [date, day] of dayMap) {
      if (day.inputTokens + day.outputTokens > 0) activeDates.add(date);
    }
  }

  return {
    provider: 'TOTAL',
    days: activeDates.size,
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

export function renderTui(providerData: ProviderData, options: TuiOptions = {}): string {
  const { layoutData, keys } = resolveProviderLayout(providerData, {
    all: options.all,
    year: options.year,
  });

  let rows: StatsRow[];
  if (options.all) {
    const merged = layoutData.all;
    rows = merged && merged.size > 0 ? [summarizeDayMap(merged, 'all')] : [];
  } else {
    const summarized = keys
      .map((key) => {
        const dayMap = layoutData[key];
        return dayMap ? { row: summarizeDayMap(dayMap, key), dayMap } : null;
      })
      .filter((entry): entry is { row: StatsRow; dayMap: DayMap } => entry !== null);
    rows = summarized.map((entry) => entry.row);
    if (rows.length > 1) {
      rows.push(
        totalRow(
          rows,
          summarized.map((entry) => entry.dayMap),
        ),
      );
    }
  }

  if (rows.length === 0) return '';

  const isDark = Boolean(options.dark);
  const title =
    options.year === undefined
      ? chalk.bold('aitrack stats')
      : chalk.bold(`aitrack stats (${options.year})`);
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
      style: defaultTableStyle(isDark),
      bodyRows,
      footerRow: footer,
      firstColumnStyle: defaultTableStyle(isDark).header,
    },
  );

  return [title, subtitle, '', table].join('\n');
}
