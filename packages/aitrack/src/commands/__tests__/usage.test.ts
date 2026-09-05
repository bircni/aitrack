import { makeDay, loggedOutput } from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('aitrack-lib/data/usageData', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
  emptyUsageMessage: (warned?: boolean) =>
    warned ? 'No local usage data found.' : 'No usage data found.',
}));
vi.mock('aitrack-lib/config', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('aitrack-lib/git', () => ({ isCloned: mocks.isCloned }));

import { usageCommand } from '../usage.js';

// Fix "today" so window math is deterministic. Mid-month avoids month-boundary edge cases.
const NOW = new Date('2026-06-15T10:00:00');
const TODAY = '2026-06-15';
const TODAY_LOCALE = `${NOW.toLocaleDateString()} ${NOW.toLocaleTimeString()}`;

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
    });

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'today', providers: ['claude_code'], json: true });

    const parsed = JSON.parse(loggedOutput()) as {
      command: string;
      providers: Array<{ key: string; rows: Array<{ model: string; tokens: number }> }>;
      totals: { tokens: number; costUSD: number };
    };
    expect(parsed.command).toBe('usage');
    expect(parsed.providers[0]?.key).toBe('claude_code');
    expect(parsed.providers[0]?.rows[0]).toMatchObject({
      model: 'claude-opus-4-8',
      tokens: 1200,
    });
    expect(parsed.totals).toMatchObject({ tokens: 1200, costUSD: 1.2 });
  });

  it('prints comparison totals and per-model movement', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-06-08', makeDay(100, 0, 1, 'claude-opus')],
          ['2026-06-15', makeDay(200, 0, 3, 'claude-opus')],
        ]),
      },
      machineData: [],
    });

    await usageCommand({ period: 'thisweek', compare: true });

    const out = loggedOutput();
    expect(out).toContain('Compared with previous week to date');
    expect(out).toContain('Per-model movement');
    expect(out).toContain('claude-opus');
    expect(out).toContain('+100.0%');
    expect(out).toContain('+200.0%');
    expect(mocks.loadMergedProviderData).toHaveBeenCalledTimes(1);
  });

  it('includes structured comparison data in JSON output', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-06-08', makeDay(100, 0, 1, 'claude-opus')],
          ['2026-06-15', makeDay(200, 0, 3, 'claude-opus')],
        ]),
      },
      machineData: [],
    });

    await usageCommand({ period: 'thisweek', compare: true, json: true });

    const parsed = JSON.parse(loggedOutput()) as {
      comparison: {
        totals: { tokens: { delta: number; percentChange: number } };
        models: Array<{ model: string; costUSD: { delta: number } }>;
      };
    };
    expect(parsed.comparison.totals.tokens).toMatchObject({
      delta: 100,
      percentChange: 100,
    });
    expect(parsed.comparison.models[0]).toMatchObject({
      model: 'claude-opus',
      costUSD: { delta: 2 },
    });
  });

  it('prints valid JSON for empty data and empty windows', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);
    await usageCommand({ period: 'today', json: true });
    expect(JSON.parse(loggedOutput())).toMatchObject({
      command: 'usage',
      windowLabel: null,
      providers: [],
      rowCount: 0,
      totals: { tokens: 0 },
    });

    vi.mocked(console.log).mockClear();
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: { claude_code: new Map([['2020-01-01', makeDay(10, 0)]]) },
      machineData: [],
    });
    await usageCommand({ period: 'today', json: true });
    expect(JSON.parse(loggedOutput())).toMatchObject({
      command: 'usage',
      providers: [],
      rowCount: 0,
    });
  });

  it('today: prints no-usage message when no entry for today exists', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([['2020-01-01', makeDay(1000, 200, 1.2)]]),
      },
      machineData: [],
    });

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    expect(loggedOutput()).toContain(`No usage recorded for today (${TODAY_LOCALE}).`);
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
    });

    await usageCommand({ period: 'week', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'month', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'year', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'all', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'yesterday', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'date', from: '2026-03-10', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({
      period: 'range',
      from: '2026-05-01',
      to: '2026-05-31',
      providers: ['claude_code', 'codex'],
    });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'thisweek', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'lastweek', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'thismonth', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'lastmonth', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
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
    });

    await usageCommand({ period: 'last', n: 14, providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
    expect(out).toContain('last 14 days (2026-06-02 → 2026-06-15)');
    expect(out).toContain('$5.00');
    expect(out).not.toContain('$1.00');
  });

  it('prints empty hint when no data is loaded', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    expect(console.log).toHaveBeenCalledWith(
      'No local usage data found (Claude Code or Codex). Run: npx aitrack init to sync across machines.',
    );
  });

  it('forwards providers option to loadMergedProviderData', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);

    await usageCommand({ period: 'week', providers: ['claude_code', 'codex'] });

    expect(mocks.loadMergedProviderData).toHaveBeenCalledWith({
      providers: ['claude_code', 'codex'],
    });
  });

  describe('monthly budget', () => {
    function withJuneUsage() {
      mocks.loadMergedProviderData.mockResolvedValue({
        providerData: {
          claude_code: new Map([
            ['2026-06-03', makeDay(1_000_000, 20_000, 90, 'claude-opus-4-8')],
            ['2026-06-14', makeDay(900_000, 18_000, 82.5, 'claude-opus-4-8')],
          ]),
        },
        machineData: [],
      });
    }

    it('flags month-to-date spend against budget.monthly for the thismonth window', async () => {
      withJuneUsage();
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'x', budget: { monthlyUSD: 200 } });

      await usageCommand({ period: 'thismonth' });

      // 90 + 82.5 = 172.50 of 200 → 86% → warn.
      expect(loggedOutput()).toContain('Budget: $172.50 of $200.00 this month (86%)');
      expect(loggedOutput()).toContain('approaching your limit');
    });

    it('reports the overage once spend passes the budget', async () => {
      withJuneUsage();
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'x', budget: { monthlyUSD: 150 } });

      await usageCommand({ period: 'thismonth' });

      expect(loggedOutput()).toContain('Budget: $172.50 of $150.00 this month (115%)');
      expect(loggedOutput()).toContain('over by $22.50');
    });

    it('stays silent without a configured budget or for the rolling month window', async () => {
      withJuneUsage();
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'x' });
      await usageCommand({ period: 'thismonth' });
      expect(loggedOutput()).not.toContain('Budget:');

      vi.mocked(console.log).mockClear();
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'x', budget: { monthlyUSD: 200 } });
      await usageCommand({ period: 'month' });
      expect(loggedOutput()).not.toContain('Budget:');
    });

    it('includes the budget status in --json output', async () => {
      withJuneUsage();
      mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'x', budget: { monthlyUSD: 200 } });

      await usageCommand({ period: 'thismonth', json: true });

      const parsed = JSON.parse(loggedOutput()) as {
        budget?: { level: string; budgetUSD: number; spentUSD: number };
      };
      expect(parsed.budget).toMatchObject({ level: 'warn', budgetUSD: 200, spentUSD: 172.5 });
    });
  });

  it('renders multiple providers with em-dash for missing costs', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([[TODAY, makeDay(100, 50, 1.5, 'claude-x')]]),
        codex: new Map([[TODAY, makeDay(200, 100, undefined, 'gpt-x')]]),
      },
      machineData: [],
    });

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
    expect(out).toContain('Claude Code');
    expect(out).toContain('Codex');
    expect(out).toContain('claude-x');
    expect(out).toContain('gpt-x');
    expect(out).toContain('—');
    expect(out).toContain('$1.50');
  });
});
