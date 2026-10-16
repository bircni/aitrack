import type { UsageReport, UsageReportTotals } from '../../data/usageReport.js';

const HEADER = [
  'provider',
  'model',
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'total_tokens',
  'cost_usd',
  'pricing_status',
];

function csvField(value: string | number): string {
  let text = String(value);
  // Neutralise spreadsheet formula injection from untrusted model names.
  if (/^[=+\-@\t\r]/u.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(fields: Array<string | number>): string {
  return fields.map((field) => csvField(field)).join(',');
}

function pricingStatus(
  value: Pick<UsageReportTotals, 'hasCost' | 'hasUnpricedTokens' | 'tokens'>,
): string {
  if (!value.hasCost) return value.tokens === 0 ? 'complete' : 'unpriced';
  return value.hasUnpricedTokens ? 'partial' : 'complete';
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
          row.hasCached ? row.cachedInputTokens : '',
          row.outputTokens,
          row.tokens,
          row.hasCost ? row.costUSD.toFixed(4) : '', // Blank, not 0, when unpriced.
          pricingStatus(row),
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
      totals.hasCached ? totals.cachedInputTokens : '',
      totals.outputTokens,
      totals.tokens,
      totals.hasCost ? totals.costUSD.toFixed(4) : '',
      pricingStatus(totals),
    ]),
  );

  return `${lines.join('\n')}\n`;
}
