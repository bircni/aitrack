import {
  EXTREME_TIME_ZONES,
  loadedFrom,
  makeDay,
  makeProviderDay,
  useTimeZone,
} from '@aitrack/test-fixtures';
import { isUsageNotConfigured } from 'aitrack-lib/data/emptyState';
import type { DayEntry } from 'aitrack-lib/data/types';
import { loadMergedProviderData, mergeUsageSources } from 'aitrack-lib/data/usageData';
import { pull } from 'aitrack-lib/git';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_PERIOD } from '../../shared/types.js';
import { loadUsageSummary, summarizeUsage } from '../usage.js';

vi.mock('aitrack-lib/git', () => ({ pull: vi.fn() }));
vi.mock('aitrack-lib/data/emptyState', async (original) => ({
  ...(await original<object>()),
  isUsageNotConfigured: vi.fn(),
}));
vi.mock('aitrack-lib/data/usageData', async (original) => ({
  ...(await original<object>()),
  loadMergedProviderData: vi.fn(),
}));

describe('loadUsageSummary', () => {
  const OPTIONS = { providers: ['codex' as const], pull: true, refreshLive: false };

  beforeEach(() => {
    vi.mocked(isUsageNotConfigured).mockReturnValue(false);
    vi.mocked(pull).mockReset().mockResolvedValue(undefined);
    vi.mocked(loadMergedProviderData).mockReset().mockResolvedValue(null);
  });

  it('keeps the local usage and reports a failed pull as a warning', async () => {
    vi.mocked(pull).mockRejectedValue(new Error('offline'));
    expect(await loadUsageSummary(OPTIONS)).toEqual({
      summary: { providers: {} },
      warning: 'Could not pull synced data: offline',
    });
  });

  it('reports a failed read next to whatever the pull said', async () => {
    vi.mocked(loadMergedProviderData).mockRejectedValue(new Error('disk on fire'));
    expect(await loadUsageSummary(OPTIONS)).toEqual({ error: 'disk on fire', warning: undefined });
  });

  it('pulls only when asked and when a data repo is set up', async () => {
    await loadUsageSummary({ ...OPTIONS, pull: false });
    vi.mocked(isUsageNotConfigured).mockReturnValue(true);
    await loadUsageSummary(OPTIONS);
    expect(pull).not.toHaveBeenCalled();
  });
});

describe('summarizeUsage', () => {
  it('marks a day whose cost is only partly priced', () => {
    const now = new Date(2026, 5, 15, 12);
    const partial: DayEntry = { ...makeDay(10, 2, 1), hasUnpricedTokens: true };
    const { daily } = summarizeUsage(
      loadedFrom({
        codex: new Map([
          ['2026-06-15', partial],
          ['2026-06-14', makeDay(10, 2, 1)],
        ]),
      }),
      now,
    ).providers.codex ?? { daily: [] };
    expect(daily.slice(-2)).toEqual([
      { date: '2026-06-14', costUSD: 1 },
      { date: '2026-06-15', costUSD: 1, hasUnpricedTokens: true },
    ]);
  });

  it('builds every period and the daily series, empty where a provider has nothing', () => {
    const now = new Date(2026, 5, 15, 12);
    const summary = summarizeUsage(
      loadedFrom({
        claude_code: new Map([
          ['2026-06-15', makeDay(100, 50, 1.5, 'claude-sonnet-4-6')],
          ['2026-06-14', makeDay(10, 5, 0.25, 'claude-sonnet-4-6')],
          ['2026-04-16', makeDay(20, 10, 0.5, 'claude-sonnet-4-6')],
        ]),
        codex: new Map([['2026-06-12', makeDay(1, 1, 0)]]),
      }),
      now,
    );
    const claude = summary.providers.claude_code;
    expect(claude?.today).toEqual({
      tokens: 150,
      costUSD: 1.5,
      hasCost: true,
      models: [{ model: 'claude-sonnet-4-6', tokens: 150, costUSD: 1.5, hasCost: true }],
    });
    expect(claude?.yesterday.tokens).toBe(15);
    expect(claude?.last7Days.tokens).toBe(165);
    expect(claude?.last30Days.tokens).toBe(165);
    expect(claude?.allTime.tokens).toBe(195);
    expect(claude?.daily).toHaveLength(90);
    expect(claude?.daily.at(-1)).toEqual({ date: '2026-06-15', costUSD: 1.5 });
    expect(summary.providers.codex?.today).toEqual(EMPTY_PERIOD);
    expect(summary.providers.cursor).toBeUndefined();
    expect(summarizeUsage(null)).toEqual({ providers: {} });
  });

  it('groups usage by project for every period and adds the remainder up to the provider totals', () => {
    const now = new Date(2026, 5, 15, 12);
    const attributed = {
      ...makeDay(100, 50, 1.5, 'claude-sonnet-4-6'),
      byProject: { 'acme/widget': { inputTokens: 90, outputTokens: 0, costUSD: 1 } },
    };
    const summary = summarizeUsage(
      loadedFrom({
        claude_code: new Map([
          ['2026-06-15', attributed],
          ['2026-06-01', makeDay(20, 10, 0.5, 'claude-sonnet-4-6')],
        ]),
        cursor: new Map([['2026-06-15', makeDay(5, 5, 0.5, 'auto')]]),
      }),
      now,
    );
    const { projects } = summary;
    expect(projects?.today.map((entry) => [entry.project, entry.tokens])).toEqual([
      ['acme/widget', 90],
      ['(unattributed)', 60],
    ]);
    expect(projects?.today[1]).toMatchObject({ unattributed: true, costUSD: 0.5 });
    expect(projects?.last7Days).toEqual(projects?.today);
    expect(projects?.last30Days.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(
      summary.providers.claude_code?.last30Days.tokens, // Cursor is not attributed, so it is not here.
    );
    expect(projects?.allTime.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(
      summary.providers.claude_code?.allTime.tokens,
    );
  });

  it('counts an unsynced local machine alongside persisted machines', () => {
    const summary = summarizeUsage(
      mergeUsageSources([
        { hostname: 'remote', timezone: 'UTC', lastUpdated: '', current: false, days: {} },
        { hostname: 'here', timezone: 'UTC', lastUpdated: '', current: true, days: {} },
      ]),
      new Date(2026, 5, 15, 12),
    );
    expect(summary.machines).toHaveLength(2);
  });
});

// The sources are in UTC, and each period is that source's own calendar day.
describe("summarizeUsage in the sources' zone", () => {
  useTimeZone('UTC');

  it('splits usage per machine and keeps live providers apart as account usage', () => {
    const now = new Date(2026, 5, 15, 12);
    const cursorDay = makeDay(5, 5, 0.5, 'auto');
    const summary = summarizeUsage(
      mergeUsageSources(
        [
          {
            hostname: 'desk',
            timezone: 'UTC',
            lastUpdated: '2026-06-15T08:00:00Z',
            current: false,
            days: {
              '2026-06-15': { claude_code: makeProviderDay(100, 50, 1.5, 'claude-sonnet-4-6') },
            },
          },
          {
            hostname: 'laptop',
            timezone: 'UTC',
            lastUpdated: '',
            current: true,
            days: { '2026-06-14': { codex: makeProviderDay(10, 10, 0.2, 'gpt-5') } },
          },
        ],
        { cursor: new Map([['2026-06-15', cursorDay]]) },
      ),
      now,
    );
    const [desk, laptop] = summary.machines ?? [];
    expect(desk).toMatchObject({
      name: 'desk',
      current: false,
      lastUpdated: '2026-06-15T08:00:00Z',
    });
    expect(desk?.providers.claude_code?.today).toMatchObject({ tokens: 150, costUSD: 1.5 });
    expect(desk?.providers.codex).toBeUndefined();
    expect(laptop).toMatchObject({ name: 'laptop', current: true });
    expect(laptop?.providers.codex?.yesterday).toMatchObject({ tokens: 20, costUSD: 0.2 });
    expect(laptop?.providers.codex?.daily.at(-2)).toEqual({ date: '2026-06-14', costUSD: 0.2 });
    expect(Object.keys(summary.account ?? {})).toEqual(['cursor']);
    expect(summary.account?.cursor?.today).toMatchObject({ tokens: 10, costUSD: 0.5 });
  });
});

for (const zone of EXTREME_TIME_ZONES) {
  describe(`desktop report clock in ${zone}`, () => {
    useTimeZone(zone);
    it('anchors report periods and chart days to the same supplied calendar instant', () => {
      const now = new Date('2026-01-01T00:15:00Z');
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
      const day: DayEntry = makeDay(10, 2, 1);
      for (const counts of Object.values(day.byModel)) counts.hasUnpricedTokens = true;
      const summary = summarizeUsage(loadedFrom({ claude_code: new Map([[date, day]]) }), now);
      expect(summary.providers.claude_code?.today).toMatchObject({
        tokens: 12,
        costUSD: 1,
        hasUnpricedTokens: true,
      });
      expect(summary.providers.claude_code?.daily.at(-1)).toEqual({ date, costUSD: 1 });
    });
  });
}
