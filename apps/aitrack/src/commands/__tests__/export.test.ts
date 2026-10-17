import { loggedOutput } from '@aitrack/test-fixtures';
import type { UsageReport } from 'aitrack-lib/data/usageReport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildUsageReport: vi.fn(),
  renderReceiptPdf: vi.fn(),
  writeFileSync: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('node:fs', () => ({ writeFileSync: mocks.writeFileSync }));
// Keep the real emptyReportMessage (it runs against the mocked config/git below);
// only buildUsageReport is stubbed.
vi.mock('aitrack-lib/data/usageReport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('aitrack-lib/data/usageReport')>()),
  buildUsageReport: mocks.buildUsageReport,
}));
vi.mock('aitrack-lib/display/pdf/receipt', () => ({ renderReceiptPdf: mocks.renderReceiptPdf }));
vi.mock('aitrack-lib/config', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('aitrack-lib/git', () => ({ isCloned: mocks.isCloned }));

import { exportCommand } from '../export.js';

function report(rowCount: number): UsageReport {
  return {
    windowLabel: 'this month',
    providers: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      cachedInputTokens: 0,
      hasCached: false,
      costUSD: 0,
      hasCost: false,
    },
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

  it('defaults to month and writes a PDF', async () => {
    mocks.buildUsageReport.mockResolvedValue(report(3));
    await exportCommand({});
    expect(mocks.buildUsageReport).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'month' }),
    );
    expect(mocks.writeFileSync).toHaveBeenCalledWith('aitrack-receipt.pdf', expect.any(Buffer));
    expect(loggedOutput()).toContain('aitrack-receipt.pdf');
  });

  it('reports the written file as JSON', async () => {
    mocks.buildUsageReport.mockResolvedValue(report(3));
    await exportCommand({ output: 'r.pdf', json: true });
    expect(JSON.parse(loggedOutput())).toEqual({
      command: 'export',
      path: 'r.pdf',
      format: 'pdf',
      rowCount: 3,
      windowLabel: 'this month',
    });
  });

  it('writes CSV instead of a PDF with --csv, defaulting to a .csv path', async () => {
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
              cachedInputTokens: 0,
              hasCached: false,
              costUSD: 3.5,
              hasCost: true,
            },
          ],
          subtotalTokens: 1200,
          subtotalCostUSD: 3.5,
          subtotalHasCost: true,
        },
      ],
      totals: {
        inputTokens: 1000,
        outputTokens: 200,
        tokens: 1200,
        cachedInputTokens: 0,
        hasCached: false,
        costUSD: 3.5,
        hasCost: true,
      },
      rowCount: 1,
    } satisfies UsageReport);

    await exportCommand({ csv: true });

    expect(mocks.renderReceiptPdf).not.toHaveBeenCalled();
    const [path, body] = mocks.writeFileSync.mock.calls[0] as [string, string];
    expect(path).toBe('aitrack-receipt.csv');
    expect(body).toContain(
      'provider,model,input_tokens,cached_input_tokens,output_tokens,total_tokens,cost_usd',
    );
    expect(body).toContain('Claude Code,claude-opus-4-8,1000,,200,1200,3.5000');
    expect(body).toContain('TOTAL,,1000,,200,1200,3.5000');
    expect(loggedOutput()).toContain('Wrote CSV for this month → aitrack-receipt.csv');
  });

  it('honours an explicit --csv output path as given', async () => {
    mocks.buildUsageReport.mockResolvedValue(report(3));
    await exportCommand({ output: 'out.csv', csv: true });
    await exportCommand({ output: 'report.pdf', csv: true });
    expect(mocks.writeFileSync).toHaveBeenNthCalledWith(1, 'out.csv', expect.any(String));
    expect(mocks.writeFileSync).toHaveBeenNthCalledWith(2, 'report.pdf', expect.any(String));
  });

  it('passes period arguments through to the report', async () => {
    mocks.buildUsageReport.mockResolvedValue(report(3));
    await exportCommand({ period: 'last', args: ['14'], output: 'last.pdf' });
    expect(mocks.buildUsageReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ period: 'last', n: 14 }),
    );
  });

  it.each([
    ['no data is loaded', null, 'No local usage data found'],
    ['the window is empty', 0, 'No usage recorded'],
  ])('writes nothing and explains when %s', async (_label, rowCount, message) => {
    mocks.buildUsageReport.mockResolvedValue(rowCount === null ? null : report(rowCount));
    mocks.tryLoadConfig.mockReturnValue(null);
    await exportCommand({ period: 'month', output: 'r.pdf' });
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(loggedOutput()).toContain(message);
    vi.mocked(console.log).mockClear();
    await exportCommand({ period: 'month', output: 'r.pdf', json: true });
    expect(JSON.parse(loggedOutput())).toMatchObject({
      command: 'export',
      path: null,
      message: expect.stringContaining(message) as string,
    });
  });
});
