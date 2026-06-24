import { writeFileSync } from 'node:fs';

import chalk from 'chalk';

import { buildUsageReport, emptyReportMessage } from '../data/usageReport.js';
import { renderReceiptPdf } from '../display/pdf/receipt.js';
import { isNoArgPeriod as isNoArgumentPeriod, NO_ARG_PERIODS } from '../display/usagePeriods.js';

export interface ExportOptions {
  period?: string;
  output: string;
  noCursor?: boolean;
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const period = options.period ?? 'month';
  if (!isNoArgumentPeriod(period)) {
    throw new Error(`Invalid period: "${period}". Expected one of: ${NO_ARG_PERIODS.join(', ')}.`);
  }

  const report = await buildUsageReport({ period, noCursor: options.noCursor });

  if (!report || report.rowCount === 0) {
    console.log(emptyReportMessage(report));
    return;
  }

  const pdf = await renderReceiptPdf(report);
  writeFileSync(options.output, pdf);
  console.log(chalk.bold(`Wrote receipt for ${report.windowLabel} → ${options.output}`));
}
