import { writeFileSync } from 'node:fs';

import { buildUsageReport, emptyReportMessage } from 'aitrack-lib/data/usageReport';
import { renderUsageReportCsv } from 'aitrack-lib/display/csv/report';
import { renderReceiptPdf } from 'aitrack-lib/display/pdf/receipt';
import { log } from 'aitrack-lib/output';
import chalk from 'chalk';

import { printJsonCommand } from '../cli/json.js';
import { parseUsageReportOptions } from '../cli/parse.js';

export interface ExportOptions {
  period?: string;
  args?: string[];
  output?: string;
  providers?: string[];
  csv?: boolean;
  refresh?: boolean;
  json?: boolean;
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const report = await buildUsageReport({
    ...parseUsageReportOptions(options),
    ...(options.refresh !== undefined && { refreshLive: options.refresh }),
  });

  if (!report || report.rowCount === 0) {
    const message = emptyReportMessage(report);
    if (options.json) {
      printJsonCommand('export', { path: null, rowCount: 0, ...(message !== null && { message }) });
    } else if (message !== null) {
      log.info(message);
    }
    return;
  }

  const output = options.output ?? `aitrack-receipt.${options.csv ? 'csv' : 'pdf'}`;
  const format = options.csv ? 'csv' : 'pdf';
  writeFileSync(
    output,
    options.csv ? renderUsageReportCsv(report) : await renderReceiptPdf(report),
  );
  if (options.json) {
    printJsonCommand('export', {
      path: output,
      format,
      rowCount: report.rowCount,
      windowLabel: report.windowLabel,
    });
    return;
  }
  log.info(
    chalk.bold(`Wrote ${options.csv ? 'CSV' : 'receipt'} for ${report.windowLabel} → ${output}`),
  );
}
