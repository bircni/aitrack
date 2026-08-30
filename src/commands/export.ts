import { writeFileSync } from 'node:fs';

import chalk from 'chalk';

import { parseUsageReportOptions } from '../cli/parse.js';
import { buildUsageReport, emptyReportMessage } from '../data/usageReport.js';
import { renderUsageReportCsv } from '../display/csv/report.js';
import { renderReceiptPdf } from '../display/pdf/receipt.js';
import { log } from '../output.js';

export interface ExportOptions {
  period?: string;
  args?: string[];
  output: string;
  providers?: string[];
  /** Emit CSV instead of the PDF receipt. */
  csv?: boolean;
  /** Re-fetch live provider data (Cursor) instead of serving the local cache. */
  refresh?: boolean;
}

/** Default `-o` ends in `.pdf`; swap it for `.csv` when the user didn't say otherwise. */
function csvOutputPath(output: string): string {
  return output.endsWith('.pdf') ? `${output.slice(0, -'.pdf'.length)}.csv` : output;
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const report = await buildUsageReport({
    ...parseUsageReportOptions(options),
    ...(options.refresh !== undefined && { refreshLive: options.refresh }),
  });

  if (!report || report.rowCount === 0) {
    const message = emptyReportMessage(report);
    if (message !== null) log.info(message);
    return;
  }

  if (options.csv) {
    const output = csvOutputPath(options.output);
    writeFileSync(output, renderUsageReportCsv(report));
    log.info(chalk.bold(`Wrote CSV for ${report.windowLabel} → ${output}`));
    return;
  }

  const pdf = await renderReceiptPdf(report);
  writeFileSync(options.output, pdf);
  log.info(chalk.bold(`Wrote receipt for ${report.windowLabel} → ${options.output}`));
}
