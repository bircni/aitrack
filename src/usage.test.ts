import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayEntry } from './types.js';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('./show.js', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
  emptyUsageMessage: (warned?: boolean) =>
    warned ? 'No local usage data found.' : 'No usage data found.',
}));
vi.mock('./config.js', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('./git.js', () => ({ isCloned: mocks.isCloned }));

import { usageCommand } from './usage.js';

// Fix "today" so window math is deterministic. Mid-month avoids month-boundary edge cases.
const NOW = new Date('2026-06-15T10:00:00');
const TODAY = '2026-06-15';

function makeDay(input: number, output: number, costUSD?: number, model = 'm1'): DayEntry {
  const counts: Record<string, { inputTokens: number; outputTokens: number; costUSD?: number }> = {
    [model]: {
      inputTokens: input,
      outputTokens: output,
      ...(costUSD !== undefined ? { costUSD } : {}),
    },
  };
  return {
    inputTokens: input,
    outputTokens: output,
    ...(costUSD !== undefined ? { costUSD } : {}),
    byModel: counts,
  };
}

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

describe('usageCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.isCloned.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('today: prints per-model rows, TOTAL row, and today date in title', async () => {
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
                'claude-opus-4-8': { inputTokens: 800, outputTokens: 100, costUSD: 1.0 },
                'claude-sonnet-4-6': { inputTokens: 200, outputTokens: 100, costUSD: 0.2 },
              },
            },
          ],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'today', noCursor: true });

    const out = output();
    expect(out).toContain(`today (${TODAY})`);
    expect(out).toContain('Claude Code');
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('claude-sonnet-4-6');
    expect(out).toContain('TOTAL');
    expect(out).toContain('$1.20');
  });

  it('today: prints no-usage message when no entry for today exists', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([['2020-01-01', makeDay(1000, 200, 1.2)]]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'today', noCursor: true });

    expect(output()).toContain(`No usage recorded for today (${TODAY}).`);
  });

  it('week: aggregates rolling 7-day window ending today', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-06-15', makeDay(100, 0, 1)],
          ['2026-06-09', makeDay(50, 0, 0.5)],
          ['2026-06-08', makeDay(9000, 0, 90)],
          ['2025-06-15', makeDay(7000, 0, 70)],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'week', noCursor: true });

    const out = output();
    expect(out).toContain('last 7 days (2026-06-09 → 2026-06-15)');
    expect(out).toContain('$1.50');
    expect(out).not.toContain('$90');
    expect(out).not.toContain('$70');
  });

  it('month: aggregates rolling 30-day window ending today', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-06-15', makeDay(100, 0, 1)],
          ['2026-05-17', makeDay(50, 0, 0.5)],
          ['2026-05-16', makeDay(9000, 0, 90)],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'month', noCursor: true });

    const out = output();
    expect(out).toContain('last 30 days (2026-05-17 → 2026-06-15)');
    expect(out).toContain('$1.50');
    expect(out).not.toContain('$90');
  });

  it('year: only includes current calendar year', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-01-01', makeDay(100, 0, 1)],
          ['2026-12-31', makeDay(200, 0, 2)],
          ['2025-12-31', makeDay(9000, 0, 90)],
          ['2027-01-01', makeDay(8000, 0, 80)],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'year', noCursor: true });

    const out = output();
    expect(out).toContain('aitrack usage 2026');
    expect(out).toContain('$3.00');
    expect(out).not.toContain('$90');
    expect(out).not.toContain('$80');
  });

  it('all: aggregates every recorded day across history', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2020-03-15', makeDay(100, 0, 1)],
          ['2026-06-15', makeDay(200, 0, 2)],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'all', noCursor: true });

    const out = output();
    expect(out).toContain('aitrack usage all time');
    expect(out).toContain('$3.00');
  });

  it('sorts rows by cost descending within a provider', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          [
            TODAY,
            {
              inputTokens: 600,
              outputTokens: 0,
              costUSD: 11,
              byModel: {
                cheap: { inputTokens: 100, outputTokens: 0, costUSD: 1 },
                pricey: { inputTokens: 200, outputTokens: 0, costUSD: 10 },
                middle: { inputTokens: 300, outputTokens: 0, costUSD: 5 },
              },
            },
          ],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'today', noCursor: true });

    const out = output();
    const lines = out.split('\n');
    const priceyIdx = lines.findIndex((l) => l.includes('pricey'));
    const middleIdx = lines.findIndex((l) => l.includes('middle'));
    const cheapIdx = lines.findIndex((l) => l.includes('cheap'));
    expect(priceyIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(cheapIdx);
  });

  it('falls back to token sort when no model has a cost', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        codex: new Map([
          [
            TODAY,
            {
              inputTokens: 6,
              outputTokens: 0,
              byModel: {
                small: { inputTokens: 1, outputTokens: 0 },
                big: { inputTokens: 100, outputTokens: 0 },
              },
            },
          ],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'today', noCursor: true });

    const out = output();
    const lines = out.split('\n');
    const bigIdx = lines.findIndex((l) => l.includes('big'));
    const smallIdx = lines.findIndex((l) => l.includes('small'));
    expect(bigIdx).toBeLessThan(smallIdx);
  });

  it('prints empty hint when no data is loaded', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);

    await usageCommand({ period: 'today', noCursor: true });

    expect(console.log).toHaveBeenCalledWith('No local usage data found.');
  });

  it('forwards noCursor option to loadMergedProviderData', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);

    await usageCommand({ period: 'week', noCursor: true });

    expect(mocks.loadMergedProviderData).toHaveBeenCalledWith({ noCursor: true });
  });

  it('renders multiple providers with em-dash for missing costs', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([[TODAY, makeDay(100, 50, 1.5, 'claude-x')]]),
        codex: new Map([[TODAY, makeDay(200, 100, undefined, 'gpt-x')]]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'today', noCursor: true });

    const out = output();
    expect(out).toContain('Claude Code');
    expect(out).toContain('Codex');
    expect(out).toContain('claude-x');
    expect(out).toContain('gpt-x');
    expect(out).toContain('—');
    expect(out).toContain('$1.50');
  });
});
