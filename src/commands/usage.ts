import chalk from 'chalk';

import { printJsonCommand } from '../cli/json.js';
import {
  buildUsageComparison,
  buildUsageReport,
  emptyReportMessage,
  type UsageComparisonMetric,
  type UsageComparisonReport,
  type UsageReport,
  type UsageReportOptions,
} from '../data/usageReport.js';
import { fmt, fmtUSD, fmtUSDCost } from '../display/format.js';
import { defaultTableStyle, renderTerminalTable } from '../display/terminalTable.js';

export type UsageOptions = UsageReportOptions & { json?: boolean; compare?: boolean };

interface Row {
  provider: string;
  tokens: string;
  model: string;
  price: string;
  isTotal?: boolean;
}

function formatDelta(metric: UsageComparisonMetric, formatter: (value: number) => string): string {
  if (metric.delta === 0) return `${formatter(0)} (0.0%)`;
  const sign = metric.delta > 0 ? '+' : '−';
  const absolute = formatter(Math.abs(metric.delta));
  const percent =
    metric.percentChange === null
      ? metric.current > 0
        ? 'new'
        : '—'
      : `${metric.percentChange > 0 ? '+' : ''}${metric.percentChange.toFixed(1)}%`;
  return `${sign}${absolute} (${percent})`;
}

function renderUsageReport(report: UsageReport): void {
  const rows: Row[] = [];
  for (const provider of report.providers) {
    for (const row of provider.rows) {
      rows.push({
        provider: provider.label,
        tokens: fmt(row.tokens),
        model: row.model,
        price: row.hasCost ? fmtUSD(row.costUSD) : '—',
      });
    }
  }

  const totalRow: Row = {
    provider: 'TOTAL',
    tokens: fmt(report.totals.tokens),
    model: '',
    price: report.totals.hasCost ? fmtUSD(report.totals.costUSD) : '—',
    isTotal: true,
  };

  console.log(chalk.bold(`aitrack usage ${report.windowLabel}`));
  console.log(
    renderTerminalTable(
      [...rows, totalRow],
      [
        { header: 'Provider', align: 'left', cell: (r) => r.provider },
        { header: 'Tokens', align: 'right', cell: (r) => r.tokens },
        { header: 'Model', align: 'left', cell: (r) => r.model },
        { header: 'Price', align: 'right', cell: (r) => r.price },
      ],
      {
        style: defaultTableStyle(),
        bodyRows: rows,
        footerRow: totalRow,
        footerStyle: chalk.bold.cyan,
      },
    ),
  );
}

function renderComparison(report: UsageComparisonReport): void {
  const { comparison, current, previous } = report;
  const summaryRows = [
    {
      metric: 'Tokens',
      current: fmt(current.totals.tokens),
      previous: fmt(previous.totals.tokens),
      change: formatDelta(comparison.totals.tokens, fmt),
    },
    {
      metric: 'Cost',
      current: current.totals.hasCost ? fmtUSDCost(current.totals.costUSD) : '—',
      previous: previous.totals.hasCost ? fmtUSDCost(previous.totals.costUSD) : '—',
      change: comparison.totals.hasCost ? formatDelta(comparison.totals.costUSD, fmtUSDCost) : '—',
    },
  ];

  console.log('');
  console.log(chalk.bold(`Compared with ${comparison.previousWindowLabel}`));
  console.log(
    renderTerminalTable(
      summaryRows,
      [
        { header: 'Metric', align: 'left', cell: (r) => r.metric },
        { header: 'Current', align: 'right', cell: (r) => r.current },
        { header: 'Previous', align: 'right', cell: (r) => r.previous },
        { header: 'Change', align: 'right', cell: (r) => r.change },
      ],
      { style: defaultTableStyle() },
    ),
  );

  const movementRows = comparison.models
    .filter((model) => model.tokens.delta !== 0 || model.costUSD.delta !== 0)
    .map((model) => ({
      provider: model.providerLabel,
      model: model.model,
      tokens: formatDelta(model.tokens, fmt),
      cost: model.hasCost ? formatDelta(model.costUSD, fmtUSDCost) : '—',
    }));
  if (movementRows.length === 0) {
    console.log('\nNo per-model movement.');
    return;
  }

  console.log('');
  console.log(chalk.bold('Per-model movement'));
  console.log(
    renderTerminalTable(
      movementRows,
      [
        { header: 'Provider', align: 'left', cell: (r) => r.provider },
        { header: 'Model', align: 'left', cell: (r) => r.model },
        { header: 'Tokens Δ', align: 'right', cell: (r) => r.tokens },
        { header: 'Cost Δ', align: 'right', cell: (r) => r.cost },
      ],
      { style: defaultTableStyle() },
    ),
  );
}

export async function usageCommand(options: UsageOptions): Promise<void> {
  const comparisonReport = options.compare ? await buildUsageComparison(options) : null;
  const report = options.compare
    ? (comparisonReport?.current ?? null)
    : await buildUsageReport(options);

  if (options.json) {
    const message = emptyReportMessage(report);
    const emptyTotals = {
      inputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      costUSD: 0,
      hasCost: false,
    };
    printJsonCommand('usage', {
      windowLabel: report?.windowLabel ?? null,
      providers: report?.providers ?? [],
      totals: report?.totals ?? emptyTotals,
      rowCount: report?.rowCount ?? 0,
      ...(comparisonReport !== null && { comparison: comparisonReport.comparison }),
      ...(message !== null && { message }),
    });
    return;
  }

  if (!report) {
    console.log(emptyReportMessage(report));
    return;
  }

  if (report.rowCount === 0) {
    console.log(emptyReportMessage(report));
  } else {
    renderUsageReport(report);
  }

  if (comparisonReport) renderComparison(comparisonReport);
}
