import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loggedOutput } from '../../__tests__/helpers/fixtures.js';
import type { UsageReport } from '../../data/usageReport.js';

const mocks = vi.hoisted(() => ({
  buildUsageReport: vi.fn(),
  renderReceiptPdf: vi.fn(),
  writeFileSync: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('node:fs', () => ({ writeFileSync: mocks.writeFileSync }));
// Keep the real emptyReportMessage (it runs against the mocked config/git/usageData
// below); only buildUsageReport is stubbed.
vi.mock('../../data/usageReport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../data/usageReport.js')>()),
  buildUsageReport: mocks.buildUsageReport,
}));
vi.mock('../../display/pdf/receipt.js', () => ({ renderReceiptPdf: mocks.renderReceiptPdf }));
vi.mock('../../data/usageData.js', () => ({
  emptyUsageMessage: (warned?: boolean) => (warned ? 'not configured' : 'no data'),
}));
vi.mock('../../config.js', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('../../git.js', () => ({ isCloned: mocks.isCloned }));

import { exportCommand } from '../export.js';

function report(rowCount: number): UsageReport {
  return {
    windowLabel: 'this month',
    providers: [],
    totals: { inputTokens: 0, outputTokens: 0, tokens: 0, costUSD: 0, hasCost: false },
    rowCount,
  };
}

describe('exportCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'x' });
    mocks.isCloned.mockReturnValue(true);
    mocks.renderReceiptPdf.mockResolvedValue(Buffer.from('%PDF-fake'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an invalid period', async () => {
    await expect(exportCommand({ period: 'fortnight', output: 'r.pdf' })).rejects.toThrow(
      'Invalid period',
    );
  });

  it('rejects missing or invalid extra period arguments', async () => {
    await expect(exportCommand({ period: 'range', output: 'r.pdf' })).rejects.toThrow(
      'aitrack export range',
    );
    await expect(exportCommand({ period: 'date', args: ['bad'], output: 'r.pdf' })).rejects.toThrow(
      'Invalid date',
    );
    await expect(
      exportCommand({ period: 'range', args: ['2026-06-02', '2026-06-01'], output: 'r.pdf' }),
    ).rejects.toThrow('must not be after');
    await expect(exportCommand({ period: 'last', args: ['0'], output: 'r.pdf' })).rejects.toThrow(
      'positive integer',
    );
  });

  it('defaults to month and writes a PDF', async () => {
    mocks.buildUsageReport.mockResolvedValue(report(3));
    await exportCommand({ output: 'r.pdf' });
    expect(mocks.buildUsageReport).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'month' }),
    );
    expect(mocks.writeFileSync).toHaveBeenCalledWith('r.pdf', expect.any(Buffer));
    expect(loggedOutput()).toContain('r.pdf');
  });

  it('writes CSV instead of a PDF with --csv, swapping the default extension', async () => {
    mocks.buildUsageReport.mockResolvedValue({
      windowLabel: 'this month',
      providers: [
        {
          key: 'claude_code',
          label: 'Claude Code',
          rows: [
            {
              model: 'claude-opus-4-8',
              inputTokens: 1000,
              outputTokens: 200,
              tokens: 1200,
              costUSD: 3.5,
              hasCost: true,
            },
          ],
          subtotalTokens: 1200,
          subtotalCostUSD: 3.5,
          subtotalHasCost: true,
        },
      ],
      totals: { inputTokens: 1000, outputTokens: 200, tokens: 1200, costUSD: 3.5, hasCost: true },
      rowCount: 1,
    } satisfies UsageReport);

    await exportCommand({ output: 'aitrack-receipt.pdf', csv: true });

    expect(mocks.renderReceiptPdf).not.toHaveBeenCalled();
    const [path, body] = mocks.writeFileSync.mock.calls[0] as [string, string];
    expect(path).toBe('aitrack-receipt.csv');
    expect(body).toContain('provider,model,input_tokens,output_tokens,total_tokens,cost_usd');
    expect(body).toContain('Claude Code,claude-opus-4-8,1000,200,1200,3.5000');
    expect(body).toContain('TOTAL,,1000,200,1200,3.5000');
    expect(loggedOutput()).toContain('Wrote CSV for this month → aitrack-receipt.csv');
  });

  it('honours an explicit --csv output path as given', async () => {
    mocks.buildUsageReport.mockResolvedValue(report(3));
    await exportCommand({ output: 'out.csv', csv: true });
    expect((mocks.writeFileSync.mock.calls[0] as [string, string])[0]).toBe('out.csv');
  });

  it('exports date, range, and last windows', async () => {
    mocks.buildUsageReport.mockResolvedValue(report(3));
    await exportCommand({ period: 'date', args: ['2026-06-01'], output: 'date.pdf' });
    expect(mocks.buildUsageReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ period: 'date', from: '2026-06-01' }),
    );

    await exportCommand({
      period: 'range',
      args: ['2026-06-01', '2026-06-02'],
      output: 'range.pdf',
    });
    expect(mocks.buildUsageReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ period: 'range', from: '2026-06-01', to: '2026-06-02' }),
    );

    await exportCommand({ period: 'last', args: ['14'], output: 'last.pdf' });
    expect(mocks.buildUsageReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ period: 'last', n: 14 }),
    );
  });

  it('prints the not-configured hint and writes nothing when no data is loaded', async () => {
    mocks.buildUsageReport.mockResolvedValue(null);
    mocks.tryLoadConfig.mockReturnValue(null);
    await exportCommand({ period: 'month', output: 'r.pdf' });
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(loggedOutput()).toContain('No local usage data found');
  });

  it('prints a no-usage message when the window is empty', async () => {
    mocks.buildUsageReport.mockResolvedValue(report(0));
    await exportCommand({ period: 'month', output: 'r.pdf' });
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(loggedOutput()).toContain('No usage recorded');
  });
});
