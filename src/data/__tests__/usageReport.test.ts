import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DayEntry } from '../types.js';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
}));

vi.mock('../usageData.js', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
}));

import { buildUsageReport } from '../usageReport.js';

const NOW = new Date('2026-06-15T10:00:00');
const TODAY = '2026-06-15';

function makeDay(input: number, output: number, costUSD?: number, model = 'm1'): DayEntry {
  return {
    inputTokens: input,
    outputTokens: output,
    ...(costUSD === undefined ? {} : { costUSD }),
    byModel: {
      [model]: {
        inputTokens: input,
        outputTokens: output,
        ...(costUSD === undefined ? {} : { costUSD }),
      },
    },
  };
}

describe('buildUsageReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when no provider data is loaded', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);
    expect(await buildUsageReport({ period: 'today' })).toBeNull();
  });

  it('returns rowCount 0 when data exists but nothing falls in the window', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: { claude_code: new Map([['2020-01-01', makeDay(100, 20, 1)]]) },
      machineData: [],
      fileCount: 1,
    });
    const report = await buildUsageReport({ period: 'today' });
    expect(report).not.toBeNull();
    expect(report?.rowCount).toBe(0);
    expect(report?.providers).toEqual([]);
  });

  it('aggregates per-model rows, subtotals, and totals', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          [
            TODAY,
            {
              inputTokens: 1000,
              outputTokens: 200,
              costUSD: 1.2,
              byModel: {
                'claude-opus-4-8': { inputTokens: 800, outputTokens: 100, costUSD: 1 },
                'claude-sonnet-4-6': { inputTokens: 200, outputTokens: 100, costUSD: 0.2 },
              },
            },
          ],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    const report = await buildUsageReport({ period: 'today' });
    expect(report?.rowCount).toBe(2);
    const provider = report?.providers[0];
    expect(provider?.label).toBe('Claude Code');
    // sorted by cost desc → opus first
    expect(provider?.rows[0]?.model).toBe('claude-opus-4-8');
    expect(provider?.subtotalCostUSD).toBeCloseTo(1.2);
    expect(report?.totals.tokens).toBe(1200);
    expect(report?.totals.costUSD).toBeCloseTo(1.2);
    expect(report?.totals.hasCost).toBe(true);
  });

  it('marks rows without cost as hasCost false', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: { claude_code: new Map([[TODAY, makeDay(500, 100)]]) },
      machineData: [],
      fileCount: 1,
    });
    const report = await buildUsageReport({ period: 'today' });
    expect(report?.providers[0]?.rows[0]?.hasCost).toBe(false);
    expect(report?.totals.hasCost).toBe(false);
  });
});
