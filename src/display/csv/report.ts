import type { UsageReport } from '../../data/usageReport.js';

/**
 * The same window/provider/model breakdown the PDF receipt shows, as CSV — raw
 * integer token counts and a plain dollar figure so it drops straight into a
 * spreadsheet. One row per provider+model, then a TOTAL row; the cost cell is
 * left blank (not `0`) for providers with no known pricing.
 */
const HEADER = ['provider', 'model', 'input_tokens', 'output_tokens', 'total_tokens', 'cost_usd'];

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(fields: Array<string | number>): string {
  return fields.map((field) => csvField(field)).join(',');
}

export function renderUsageReportCsv(report: UsageReport): string {
  const lines = [csvLine(HEADER)];

  for (const provider of report.providers) {
    for (const row of provider.rows) {
      lines.push(
        csvLine([
          provider.label,
          row.model,
          row.inputTokens,
          row.outputTokens,
          row.tokens,
          row.hasCost ? row.costUSD.toFixed(4) : '',
        ]),
      );
    }
  }

  const { totals } = report;
  lines.push(
    csvLine([
      'TOTAL',
      '',
      totals.inputTokens,
      totals.outputTokens,
      totals.tokens,
      totals.hasCost ? totals.costUSD.toFixed(4) : '',
    ]),
  );

  return `${lines.join('\n')}\n`;
}
