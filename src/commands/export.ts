import { writeFileSync } from 'node:fs';

import chalk from 'chalk';

import { parseUsageReportOptions } from '../cli/parse.js';
import { buildUsageReport, emptyReportMessage } from '../data/usageReport.js';
import { renderReceiptPdf } from '../display/pdf/receipt.js';
import { log } from '../output.js';

export interface ExportOptions {
  period?: string;
  args?: string[];
  output: string;
  providers?: string[];
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const report = await buildUsageReport(parseUsageReportOptions(options));

  if (!report || report.rowCount === 0) {
    const message = emptyReportMessage(report);
    if (message !== null) log.info(message);
    return;
  }

  const pdf = await renderReceiptPdf(report);
  writeFileSync(options.output, pdf);
  log.info(chalk.bold(`Wrote receipt for ${report.windowLabel} → ${options.output}`));
}
