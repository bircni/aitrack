import { writeFileSync } from 'node:fs';

import chalk from 'chalk';

import { parseUsageReportOptions } from '../cli/parse.js';
import { buildUsageReport, emptyReportMessage } from '../data/usageReport.js';
import { renderReceiptPdf } from '../display/pdf/receipt.js';

export interface ExportOptions {
  period?: string;
  args?: string[];
  output: string;
  providers?: string[];
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const report = await buildUsageReport(parseUsageReportOptions(options));

  if (!report || report.rowCount === 0) {
    console.log(emptyReportMessage(report));
    return;
  }

  const pdf = await renderReceiptPdf(report);
  writeFileSync(options.output, pdf);
  console.log(chalk.bold(`Wrote receipt for ${report.windowLabel} → ${options.output}`));
}
