import { describe, expect, it } from 'vitest';

import type { UsageReport } from '../../../data/usageReport.js';
import { localTimestamp, renderReceiptPdf } from '../receipt.js';

function sampleReport(): UsageReport {
  return {
    windowLabel: 'last 30 days (2026-05-17 → 2026-06-15)',
    providers: [
      {
        key: 'claude_code',
        label: 'Claude Code',
        rows: [
          {
            model: 'claude-opus-4-8',
            inputTokens: 800,
            outputTokens: 100,
            tokens: 900,
            costUSD: 1,
            hasCost: true,
          },
          {
            model: 'no-price-model',
            inputTokens: 10,
            outputTokens: 5,
            tokens: 15,
            costUSD: 0,
            hasCost: false,
          },
        ],
        subtotalTokens: 915,
        subtotalCostUSD: 1,
        subtotalHasCost: true,
      },
    ],
    totals: { inputTokens: 810, outputTokens: 105, tokens: 915, costUSD: 1, hasCost: true },
    rowCount: 2,
  };
}

describe('renderReceiptPdf', () => {
  it('produces a non-empty PDF buffer', async () => {
    const buffer = await renderReceiptPdf(sampleReport(), new Date('2026-06-15T10:00:00Z'));
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('renders a report with no priced rows without throwing', async () => {
    const report = sampleReport();
    report.totals.hasCost = false;
    for (const provider of report.providers) provider.subtotalHasCost = false;
    const buffer = await renderReceiptPdf(report);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('fits on a single page even with many rows', async () => {
    const report = sampleReport();
    const provider = report.providers[0];
    if (!provider) throw new Error('expected a provider');
    provider.rows = Array.from({ length: 60 }, (_, index) => ({
      model: `model-${String(index)}`,
      inputTokens: 10,
      outputTokens: 5,
      tokens: 15,
      costUSD: 0.01,
      hasCost: true,
    }));
    const buffer = await renderReceiptPdf(report);
    // PDFKit emits one "/Type /Page" object per page; sizing to content keeps it to one.
    const pageCount = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
    expect(pageCount).toBe(1);
  });
});

describe('localTimestamp', () => {
  it('formats a Date in local time as YYYY-MM-DD HH:MM:SS', () => {
    // Constructed without a zone suffix → interpreted as local time, so the
    // formatted output is independent of the runner's timezone.
    const at = new Date(2026, 5, 15, 9, 8, 7);
    expect(localTimestamp(at)).toBe('2026-06-15 09:08:07');
  });
});
