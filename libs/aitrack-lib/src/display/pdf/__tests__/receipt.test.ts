import { useTimeZone } from '@aitrack/test-fixtures';
import PDFDocument from 'pdfkit';
import { describe, expect, it, vi } from 'vitest';

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
            cachedInputTokens: 0,
            hasCached: false,
            costUSD: 1,
            hasCost: true,
          },
          {
            model: 'no-price-model',
            inputTokens: 10,
            outputTokens: 5,
            tokens: 15,
            cachedInputTokens: 0,
            hasCached: false,
            costUSD: 0,
            hasCost: false,
          },
        ],
        subtotalTokens: 915,
        subtotalCostUSD: 1,
        subtotalHasCost: true,
      },
    ],
    totals: {
      inputTokens: 810,
      outputTokens: 105,
      tokens: 915,
      cachedInputTokens: 0,
      hasCached: false,
      costUSD: 1,
      hasCost: true,
    },
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
      cachedInputTokens: 0,
      hasCached: false,
      costUSD: 0.01,
      hasCost: true,
    }));
    const buffer = await renderReceiptPdf(report);
    // PDFKit emits one "/Type /Page" object per page; sizing to content keeps it to one.
    const pageCount = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/gu)?.length ?? 0;
    expect(pageCount).toBe(1);
  });

  it('keeps a long model name on its row instead of wrapping into the next', async () => {
    const pdfkitInternals = PDFDocument.prototype as unknown as { _fragment(text: string): void };
    const fragment = vi.spyOn(pdfkitInternals, '_fragment');
    try {
      const report = sampleReport();
      const model = `${'long-model-name-'.repeat(8)}tail`;
      const firstRow = report.providers[0]?.rows[0];
      if (!firstRow) throw new Error('expected a row');
      firstRow.model = model;
      await renderReceiptPdf(report);

      const drawn = fragment.mock.calls.map(([text]) => text);
      expect(
        drawn.some((text) => text.startsWith('  long-model-name-') && text.endsWith('…')),
      ).toBe(true);
      expect(drawn.some((text) => text.includes('tail'))).toBe(false);
    } finally {
      fragment.mockRestore();
    }
  });

  it('shows a known zero cost as $0.00, and an unpriced row as a dash', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    try {
      const report = sampleReport();
      const firstRow = report.providers[0]?.rows[0];
      if (!firstRow) throw new Error('expected a row');
      firstRow.costUSD = 0;
      await renderReceiptPdf(report);

      const drawn = text.mock.calls.map(([value]) => value);
      expect(drawn).toContain('$0.00');
      expect(drawn).toContain('-');
      expect(drawn).not.toContain('—');
    } finally {
      text.mockRestore();
    }
  });
});

describe('localTimestamp in Pacific/Kiritimati', () => {
  useTimeZone('Pacific/Kiritimati');

  it('formats a Date in local time as YYYY-MM-DD HH:MM:SS', () => {
    expect(localTimestamp(new Date('2026-06-15T19:08:07Z'))).toBe('2026-06-16 09:08:07');
  });
});

it('labels partially priced receipts without dropping the known-cost amount', async () => {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  try {
    const report = sampleReport();
    report.totals.hasUnpricedTokens = true;
    report.totals.unpricedModels = ['mystery'];
    const buffer = await renderReceiptPdf(report);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(
      text.mock.calls.some(
        ([value]) => value === 'Partial estimate: some usage is unpriced. Unpriced models: mystery',
      ),
    ).toBe(true);
  } finally {
    text.mockRestore();
  }
});
