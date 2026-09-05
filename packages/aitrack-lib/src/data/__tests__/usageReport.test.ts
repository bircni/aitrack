import { makeDay } from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
}));

vi.mock('../usageData.js', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
}));

import { buildUsageComparison, buildUsageReport } from '../usageReport.js';

const NOW = new Date('2026-06-15T10:00:00');
const TODAY = '2026-06-15';

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
    });
    const report = await buildUsageReport({ period: 'today' });
    expect(report?.providers[0]?.rows[0]?.hasCost).toBe(false);
    expect(report?.totals.hasCost).toBe(false);
  });

  it('compares totals and per-model movement using one data load', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-06-08', makeDay(100, 0, 1, 'shared')],
          ['2026-06-15', makeDay(200, 0, 3, 'shared')],
        ]),
        codex: new Map([['2026-06-08', makeDay(50, 0, undefined, 'removed')]]),
      },
      machineData: [],
    });

    const result = await buildUsageComparison({ period: 'thisweek' });

    expect(mocks.loadMergedProviderData).toHaveBeenCalledTimes(1);
    expect(result?.comparison.previousWindowLabel).toContain('2026-06-08');
    expect(result?.comparison.totals.tokens).toMatchObject({
      current: 200,
      previous: 150,
      delta: 50,
    });
    expect(result?.comparison.totals.costUSD.percentChange).toBe(200);
    const shared = result?.comparison.models.find((model) => model.model === 'shared');
    expect(shared).toMatchObject({ providerKey: 'claude_code', model: 'shared' });
    expect(shared?.tokens).toMatchObject({ delta: 100, percentChange: 100 });
    expect(shared?.costUSD).toMatchObject({ delta: 2, percentChange: 200 });

    const removed = result?.comparison.models.find((model) => model.model === 'removed');
    expect(removed).toMatchObject({
      providerKey: 'codex',
      model: 'removed',
      hasCost: false,
    });
    expect(removed?.tokens).toMatchObject({ delta: -50, percentChange: -100 });
  });

  it('rejects comparison for all-time usage', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: { claude_code: new Map([[TODAY, makeDay(100, 20, 1)]]) },
      machineData: [],
    });

    await expect(buildUsageComparison({ period: 'all' })).rejects.toThrow(
      'does not have a comparable previous period',
    );
  });
});
