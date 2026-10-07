import { makeDay, loggedOutput } from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('aitrack-lib/data/usageData', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
}));
vi.mock('aitrack-lib/config', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('aitrack-lib/git', () => ({ isCloned: mocks.isCloned }));

import { usageCommand } from '../usage.js';

// Fix "today" so window math is deterministic. Mid-month avoids month-boundary edge cases.
const NOW = new Date('2026-06-15T10:00:00');
const TODAY = '2026-06-15';
const TODAY_LOCALE = `${NOW.toLocaleDateString()} ${NOW.toLocaleTimeString()}`;

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
    expect(out).toContain('Opus 4.8');
    expect(out).toContain('Sonnet 4.6');
    expect(out).toContain('TOTAL');
    expect(out).toContain('$1.20');
    expect(out).not.toContain('Cached');
    expect(out).not.toContain('prompt-cache hits');
    expect(out.slice(out.indexOf('┌'))).toMatchInlineSnapshot(`
      "┌─────────────┬────────┬────────────┬───────┐
      │ Provider    │ Tokens │ Model      │ Price │
      ├─────────────┼────────┼────────────┼───────┤
      │ Claude Code │    900 │ Opus 4.8   │ $1.00 │
      │ Claude Code │    300 │ Sonnet 4.6 │ $0.20 │
      ├─────────────┼────────┼────────────┼───────┤
      │ TOTAL       │   1.2K │            │ $1.20 │
      └─────────────┴────────┴────────────┴───────┘"
    `);
  });

  it('shows cached input and the cache-rate note for Codex rows', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        codex: new Map([
          [
            TODAY,
            {
              inputTokens: 5_000_000,
              outputTokens: 20_000,
              cachedInputTokens: 4_800_000,
              costUSD: 7.21,
              byModel: {
                'gpt-6-astra': {
                  inputTokens: 5_000_000,
                  outputTokens: 20_000,
                  cachedInputTokens: 4_800_000,
                  costUSD: 7.21,
                },
              },
            },
          ],
        ]),
      },
      machineData: [],
    });

    await usageCommand({ period: 'today', providers: ['codex'] });

    const out = loggedOutput();
    expect(out).toContain('GPT-6 Astra');
    expect(out).toContain('5.0M');
    expect(out).toContain('4.8M');
    expect(out).toContain('$7.21');
    expect(out).toContain('Cached is included in Tokens');
    expect(out.slice(out.indexOf('┌'))).toMatchInlineSnapshot(`
      "┌──────────┬────────┬────────┬─────────────┬───────┐
      │ Provider │ Tokens │ Cached │ Model       │ Price │
      ├──────────┼────────┼────────┼─────────────┼───────┤
      │ Codex    │   5.0M │   4.8M │ GPT-6 Astra │ $7.21 │
      ├──────────┼────────┼────────┼─────────────┼───────┤
      │ TOTAL    │   5.0M │   4.8M │             │ $7.21 │
      └──────────┴────────┴────────┴─────────────┴───────┘
      Cached is included in Tokens (prompt-cache hits, billed cheaper)."
    `);
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
    expect(out).toContain('Opus');
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
        claude_code: new Map([[TODAY, makeDay(100, 50, 1.5, 'mystery-claude')]]),
        codex: new Map([[TODAY, makeDay(200, 100, undefined, 'mystery-gpt')]]),
      },
      machineData: [],
    });

    await usageCommand({ period: 'today', providers: ['claude_code', 'codex'] });

    const out = loggedOutput();
    expect(out).toContain('Claude Code');
    expect(out).toContain('Codex');
    expect(out).toContain('mystery-claude');
    expect(out).toContain('mystery-gpt');
    expect(out).toContain('—');
    expect(out).toContain('$1.50');
    expect(out).toContain('┌');
    expect(out).toContain('└');
  });

  it('pretty-prints Cursor model slugs in the usage table', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        cursor: new Map([
          [
            TODAY,
            {
              inputTokens: 39_100_000,
              outputTokens: 1_000_000,
              cachedInputTokens: 37_200_000,
              costUSD: 53.12,
              byModel: {
                'cursor-grok-4.6-xhigh-fast': {
                  inputTokens: 36_600_000,
                  outputTokens: 800_000,
                  cachedInputTokens: 34_900_000,
                  costUSD: 43.87,
                },
                'claude-sonnet-4-5': {
                  inputTokens: 2_500_000,
                  outputTokens: 200_000,
                  costUSD: 9.25,
                },
              },
            },
          ],
        ]),
      },
      machineData: [],
    });

    await usageCommand({ period: 'today', providers: ['cursor'] });

    const out = loggedOutput();
    expect(out).toContain('Grok 4.6 xhigh fast');
    expect(out).toContain('Sonnet 4.5');
    expect(out).not.toContain('cursor-grok');
    expect(out).toContain('┌');
    expect(out).toContain('└');
  });

  it('marks partially priced model, total, budget and comparison estimates', async () => {
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'repo', budget: { monthlyUSD: 10 } });
    const mixed = {
      inputTokens: 10,
      outputTokens: 2,
      costUSD: 1,
      hasUnpricedTokens: true,
      byModel: { mixed: { inputTokens: 10, outputTokens: 2, costUSD: 1, hasUnpricedTokens: true } },
    };
    mocks.loadMergedProviderData.mockResolvedValue({
      machineData: [],
      providerData: {
        claude_code: new Map([
          ['2026-06-01', mixed],
          ['2026-05-01', mixed],
        ]),
      },
    });
    await usageCommand({ period: 'thismonth', compare: true });
    expect(loggedOutput()).toContain('(partial)');
    expect(loggedOutput()).toContain('Cost comparison is a partial estimate');
    expect(loggedOutput()).toContain('Budget spend is a partial estimate');
  });
});
