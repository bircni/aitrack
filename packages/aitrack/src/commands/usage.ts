import { tryLoadConfig } from 'aitrack-lib/config';
import { type BudgetStatus, budgetStatus } from 'aitrack-lib/data/budget';
import {
  buildUsageComparison,
  buildUsageReport,
  emptyReportMessage,
  type UsageComparisonMetric,
  type UsageComparisonReport,
  type UsageReport,
  type UsageReportOptions,
} from 'aitrack-lib/data/usageReport';
import { fmt, fmtUSD, fmtUSDCost } from 'aitrack-lib/display/format';
import { defaultTableStyle, renderTerminalTable } from 'aitrack-lib/display/terminalTable';
import { log } from 'aitrack-lib/output';
import chalk from 'chalk';

import { printJsonCommand } from '../cli/json.js';

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

  log.info(chalk.bold(`aitrack usage ${report.windowLabel}`));
  log.info(
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

  log.info('');
  log.info(chalk.bold(`Compared with ${comparison.previousWindowLabel}`));
  log.info(
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
    log.info('\nNo per-model movement.');
    return;
  }

  log.info('');
  log.info(chalk.bold('Per-model movement'));
  log.info(
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

/**
 * Month-to-date spend vs the configured `budget.monthly`, but only for the
 * `thismonth` window — the rolling `month` (last 30 days) is not a calendar
 * month, so comparing it to a monthly ceiling would mislead.
 */
function resolveBudgetStatus(options: UsageOptions, report: UsageReport): BudgetStatus | null {
  if (options.period !== 'thismonth' || !report.totals.hasCost) return null;
  const monthlyUSD = tryLoadConfig()?.budget?.monthlyUSD;
  if (monthlyUSD === undefined) return null;
  return budgetStatus(report.totals.costUSD, monthlyUSD);
}

function renderBudgetLine(status: BudgetStatus): void {
  const percent = `${String(Math.round(status.ratio * 100))}%`;
  const head = `Budget: ${fmtUSDCost(status.spentUSD)} of ${fmtUSDCost(status.budgetUSD)} this month (${percent})`;
  if (status.level === 'over') {
    log.info(chalk.red(`⚠ ${head} — over by ${fmtUSDCost(status.overUSD)}`));
  } else if (status.level === 'warn') {
    log.info(chalk.yellow(`⚠ ${head} — approaching your limit`));
  } else {
    log.info(chalk.dim(head));
  }
}

export async function usageCommand(options: UsageOptions): Promise<void> {
  const comparisonReport = options.compare ? await buildUsageComparison(options) : null;
  const report = options.compare
    ? (comparisonReport?.current ?? null)
    : await buildUsageReport(options);

  const budget = report ? resolveBudgetStatus(options, report) : null;

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
      ...(budget !== null && { budget }),
      ...(message !== null && { message }),
    });
    return;
  }

  if (!report || report.rowCount === 0) {
    const message = emptyReportMessage(report);
    if (message !== null) log.info(message);
    return;
  }

  renderUsageReport(report);

  if (budget) renderBudgetLine(budget);

  if (comparisonReport) renderComparison(comparisonReport);
}
