import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DayEntry } from '../../data/types.js';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('../../data/usageData.js', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
  emptyUsageMessage: (warned?: boolean) =>
    warned ? 'No local usage data found.' : 'No usage data found.',
}));
vi.mock('../../config.js', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('../../git.js', () => ({ isCloned: mocks.isCloned }));

import { usageCommand } from '../usage.js';

// Fix "today" so window math is deterministic. Mid-month avoids month-boundary edge cases.
const NOW = new Date('2026-06-15T10:00:00');
const TODAY = '2026-06-15';
const TODAY_LOCALE = `${NOW.toLocaleDateString()} ${NOW.toLocaleTimeString()}`;

function makeDay(input: number, output: number, costUSD?: number, model = 'm1'): DayEntry {
  const counts: Record<string, { inputTokens: number; outputTokens: number; costUSD?: number }> = {
    [model]: {
      inputTokens: input,
      outputTokens: output,
      ...(costUSD !== undefined && { costUSD }),
    },
  };
  return {
    inputTokens: input,
    outputTokens: output,
    ...(costUSD !== undefined && { costUSD }),
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

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    const out = output();
    expect(out).toContain(`today (${TODAY_LOCALE})`);
    expect(out).toContain('Claude Code');
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('claude-sonnet-4-6');
    expect(out).toContain('TOTAL');
    expect(out).toContain('$1.20');
  });

  it('prints JSON when requested', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([[TODAY, makeDay(1000, 200, 1.2, 'claude-opus-4-8')]]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'today', providers: ['claude_code'], json: true });

    const parsed = JSON.parse(output()) as {
      providers: Array<{ key: string; rows: Array<{ model: string; tokens: number }> }>;
      totals: { tokens: number; costUSD: number };
    };
    expect(parsed.providers[0]?.key).toBe('claude_code');
    expect(parsed.providers[0]?.rows[0]).toMatchObject({
      model: 'claude-opus-4-8',
      tokens: 1200,
    });
    expect(parsed.totals).toMatchObject({ tokens: 1200, costUSD: 1.2 });
  });

  it('today: prints no-usage message when no entry for today exists', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([['2020-01-01', makeDay(1000, 200, 1.2)]]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    expect(output()).toContain(`No usage recorded for today (${TODAY_LOCALE}).`);
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

    await usageCommand({ period: 'week', providers: ['claude_code', 'codex'] });

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

    await usageCommand({ period: 'month', providers: ['claude_code', 'codex'] });

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

    await usageCommand({ period: 'year', providers: ['claude_code', 'codex'] });

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

    await usageCommand({ period: 'all', providers: ['claude_code', 'codex'] });

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

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    const out = output();
    const lines = out.split('\n');
    const priceyIndex = lines.findIndex((l) => l.includes('pricey'));
    const middleIndex = lines.findIndex((l) => l.includes('middle'));
    const cheapIndex = lines.findIndex((l) => l.includes('cheap'));
    expect(priceyIndex).toBeLessThan(middleIndex);
    expect(middleIndex).toBeLessThan(cheapIndex);
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

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    const out = output();
    const lines = out.split('\n');
    const bigIndex = lines.findIndex((l) => l.includes('big'));
    const smallIndex = lines.findIndex((l) => l.includes('small'));
    expect(bigIndex).toBeLessThan(smallIndex);
  });

  it('yesterday: returns data for yesterday only', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-06-14', makeDay(100, 0, 1)],
          ['2026-06-15', makeDay(200, 0, 2)],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'yesterday', providers: ['claude_code', 'codex'] });

    const out = output();
    expect(out).toContain('yesterday (2026-06-14)');
    expect(out).toContain('$1.00');
    expect(out).not.toContain('$2.00');
  });

  it('date: returns data for the specified date only', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-03-10', makeDay(100, 0, 1)],
          ['2026-03-11', makeDay(200, 0, 2)],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'date', from: '2026-03-10', providers: ['claude_code', 'codex'] });

    const out = output();
    expect(out).toContain('2026-03-10');
    expect(out).toContain('$1.00');
    expect(out).not.toContain('$2.00');
  });

  it('range: includes only dates within the specified range', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-04-30', makeDay(100, 0, 1)],
          ['2026-05-01', makeDay(200, 0, 2)],
          ['2026-05-31', makeDay(300, 0, 3)],
          ['2026-06-01', makeDay(400, 0, 4)],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({
      period: 'range',
      from: '2026-05-01',
      to: '2026-05-31',
      providers: ['claude_code', 'codex'],
    });

    const out = output();
    expect(out).toContain('2026-05-01 → 2026-05-31');
    expect(out).toContain('$5.00');
    expect(out).not.toContain('$1.00');
    expect(out).not.toContain('$4.00');
  });

  // NOW = 2026-06-15 which is a Monday, so thisweek starts on the same day
  it('thisweek: includes Mon through today', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-06-14', makeDay(100, 0, 1)], // Sunday — last week
          ['2026-06-15', makeDay(200, 0, 2)], // Monday — this week
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'thisweek', providers: ['claude_code', 'codex'] });

    const out = output();
    expect(out).toContain('this week (2026-06-15 → 2026-06-15)');
    expect(out).toContain('$2.00');
    expect(out).not.toContain('$1.00');
  });

  it('lastweek: includes Mon–Sun of the previous calendar week', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-06-07', makeDay(100, 0, 1)], // Sunday before last week
          ['2026-06-08', makeDay(200, 0, 2)], // Monday of last week
          ['2026-06-14', makeDay(300, 0, 3)], // Sunday of last week
          ['2026-06-15', makeDay(400, 0, 4)], // Monday — this week
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'lastweek', providers: ['claude_code', 'codex'] });

    const out = output();
    expect(out).toContain('last week (2026-06-08 → 2026-06-14)');
    expect(out).toContain('$5.00');
    expect(out).not.toContain('$1.00');
    expect(out).not.toContain('$4.00');
  });

  it('thismonth: includes from the first of the month through today', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-05-31', makeDay(100, 0, 1)],
          ['2026-06-01', makeDay(200, 0, 2)],
          ['2026-06-15', makeDay(300, 0, 3)],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'thismonth', providers: ['claude_code', 'codex'] });

    const out = output();
    expect(out).toContain('this month (2026-06-01 → 2026-06-15)');
    expect(out).toContain('$5.00');
    expect(out).not.toContain('$1.00');
  });

  it('lastmonth: includes the entire previous calendar month', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-04-30', makeDay(100, 0, 1)],
          ['2026-05-01', makeDay(200, 0, 2)],
          ['2026-05-31', makeDay(300, 0, 3)],
          ['2026-06-01', makeDay(400, 0, 4)],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'lastmonth', providers: ['claude_code', 'codex'] });

    const out = output();
    expect(out).toContain('last month (2026-05-01 → 2026-05-31)');
    expect(out).toContain('$5.00');
    expect(out).not.toContain('$1.00');
    expect(out).not.toContain('$4.00');
  });

  it('last: aggregates rolling N-day window ending today', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-06-01', makeDay(100, 0, 1)], // 14 days before today — outside last 14
          ['2026-06-02', makeDay(200, 0, 2)], // 13 days before today — inside last 14
          ['2026-06-15', makeDay(300, 0, 3)],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await usageCommand({ period: 'last', n: 14, providers: ['claude_code', 'codex'] });

    const out = output();
    expect(out).toContain('last 14 days (2026-06-02 → 2026-06-15)');
    expect(out).toContain('$5.00');
    expect(out).not.toContain('$1.00');
  });

  it('prints empty hint when no data is loaded', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    expect(console.log).toHaveBeenCalledWith('No local usage data found.');
  });

  it('forwards providers option to loadMergedProviderData', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);

    await usageCommand({ period: 'week', providers: ['claude_code', 'codex'] });

    expect(mocks.loadMergedProviderData).toHaveBeenCalledWith({
      providers: ['claude_code', 'codex'],
    });
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

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    const out = output();
    expect(out).toContain('Claude Code');
    expect(out).toContain('Codex');
    expect(out).toContain('claude-x');
    expect(out).toContain('gpt-x');
    expect(out).toContain('—');
    expect(out).toContain('$1.50');
  });
});
