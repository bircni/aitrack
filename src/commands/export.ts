import { writeFileSync } from 'node:fs';

import chalk from 'chalk';

import { buildUsageReport, emptyReportMessage } from '../data/usageReport.js';
import { renderReceiptPdf } from '../display/pdf/receipt.js';
import { isNoArgPeriod, NO_ARG_PERIODS } from '../display/usagePeriods.js';

export interface ExportOptions {
  period?: string;
  output: string;
  noCursor?: boolean;
}

export async function exportCommand(opts: ExportOptions): Promise<void> {
  const period = opts.period ?? 'month';
  if (!isNoArgPeriod(period)) {
    throw new Error(`Invalid period: "${period}". Expected one of: ${NO_ARG_PERIODS.join(', ')}.`);
  }

  const report = await buildUsageReport({ period, noCursor: opts.noCursor });

  if (!report || report.rowCount === 0) {
    console.log(emptyReportMessage(report));
    return;
  }

  const pdf = await renderReceiptPdf(report);
  writeFileSync(opts.output, pdf);
  console.log(chalk.bold(`Wrote receipt for ${report.windowLabel} → ${opts.output}`));
}
