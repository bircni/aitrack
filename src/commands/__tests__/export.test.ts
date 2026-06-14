import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

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

  it('rejects a period that needs extra args (date/range/last)', async () => {
    await expect(exportCommand({ period: 'range', output: 'r.pdf' })).rejects.toThrow(
      'Invalid period',
    );
  });

  it('defaults to month and writes a PDF', async () => {
    mocks.buildUsageReport.mockResolvedValue(report(3));
    await exportCommand({ output: 'r.pdf' });
    expect(mocks.buildUsageReport).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'month' }),
    );
    expect(mocks.writeFileSync).toHaveBeenCalledWith('r.pdf', expect.any(Buffer));
    expect(output()).toContain('r.pdf');
  });

  it('prints the not-configured hint and writes nothing when no data is loaded', async () => {
    mocks.buildUsageReport.mockResolvedValue(null);
    mocks.tryLoadConfig.mockReturnValue(null);
    await exportCommand({ period: 'month', output: 'r.pdf' });
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(output()).toContain('not configured');
  });

  it('prints a no-usage message when the window is empty', async () => {
    mocks.buildUsageReport.mockResolvedValue(report(0));
    await exportCommand({ period: 'month', output: 'r.pdf' });
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(output()).toContain('No usage recorded');
  });
});
