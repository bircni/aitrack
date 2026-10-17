import { tryLoadConfig } from 'aitrack-lib/config';
import { type BudgetStatus, budgetStatus } from 'aitrack-lib/data/budget';
import {
  buildUsageComparison,
  buildUsageReport,
  emptyReportMessage,
  emptyUsageTotals,
  type UsageComparisonMetric,
  type UsageComparisonReport,
  type UsageReport,
  type UsageReportOptions,
  type UsageReportTotals,
} from 'aitrack-lib/data/usageReport';
import { fmt, fmtUSD, fmtUSDCost, unpricedFootnote } from 'aitrack-lib/display/format';
import { displayModelName } from 'aitrack-lib/display/modelNames';
import {
  defaultTableStyle,
  renderTerminalTable,
  type TerminalTableColumn,
} from 'aitrack-lib/display/terminalTable';
import { log } from 'aitrack-lib/output';
import chalk from 'chalk';

import { printJsonCommand } from '../cli/json.js';

export type UsageOptions = UsageReportOptions & {
  json?: boolean;
  compare?: boolean;
  short?: boolean;
};

interface Row {
  provider: string;
  tokens: string;
  model: string;
  price: string;
}

function priceCell(
  value: Pick<UsageReportTotals, 'hasCost' | 'costUSD' | 'hasUnpricedTokens'>,
): string {
  return value.hasCost
    ? `${fmtUSD(value.costUSD)}${value.hasUnpricedTokens ? ' (partial)' : ''}`
    : '—';
}

function shortLine(totals: UsageReportTotals): string {
  const parts = [`${fmt(totals.tokens)} tokens`];
  if (totals.hasCost) parts.unshift(priceCell(totals));
  return parts.join(' · ');
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
        model: displayModelName(row.model, { effort: true }),
        price: priceCell(row),
      });
    }
  }

  const totalRow: Row = {
    provider: 'TOTAL',
    tokens: fmt(report.totals.tokens),
    model: '',
    price: priceCell(report.totals),
  };

  const columns: Array<TerminalTableColumn<Row>> = [
    { header: 'Provider', align: 'left', cell: (r) => r.provider },
    { header: 'Tokens', align: 'right', cell: (r) => r.tokens },
    { header: 'Model', align: 'left', cell: (r) => r.model },
    { header: 'Price', align: 'right', cell: (r) => r.price },
  ];

  log.info(chalk.bold(`aitrack usage ${report.windowLabel}`));
  log.info(
    renderTerminalTable([...rows, totalRow], columns, {
      style: defaultTableStyle(),
      bodyRows: rows,
      footerRow: totalRow,
      footerStyle: chalk.bold.cyan,
    }),
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
  if (comparison.totals.hasUnpricedTokens && comparison.totals.hasCost) {
    log.info('Cost comparison is a partial estimate: some usage is unpriced.');
  }
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
      model: displayModelName(model.model, { effort: true }),
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

/** Only for `thismonth`: the rolling 30-day `month` is not a calendar month. */
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
    printJsonCommand('usage', {
      windowLabel: report?.windowLabel ?? null,
      providers: report?.providers ?? [],
      totals: report?.totals ?? emptyUsageTotals(),
      rowCount: report?.rowCount ?? 0,
      ...(comparisonReport !== null && { comparison: comparisonReport.comparison }),
      ...(budget !== null && { budget }),
      ...(report?.timezoneNote !== undefined && { timezoneNote: report.timezoneNote }),
      ...(message !== null && { message }),
    });
    return;
  }

  if (options.short) {
    // One line for status bars and prompts; an empty window prints nothing so the bar stays blank.
    if (report && report.rowCount > 0) log.info(shortLine(report.totals));
    return;
  }

  if (!report || report.rowCount === 0) {
    const message = emptyReportMessage(report);
    if (message !== null) log.info(message);
    return;
  }

  renderUsageReport(report);
  const footnote = unpricedFootnote(report.totals.unpricedModels);
  if (footnote !== null) log.info(chalk.dim(footnote));
  if (report.timezoneNote) log.info(chalk.dim(report.timezoneNote));

  if (budget) {
    renderBudgetLine(budget);
    if (report.totals.hasUnpricedTokens) log.info('Budget spend is a partial estimate.');
  }

  if (comparisonReport) renderComparison(comparisonReport);
}
