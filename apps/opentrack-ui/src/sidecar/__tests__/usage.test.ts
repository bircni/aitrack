import { EXTREME_TIME_ZONES, makeDay, makeProviderDay, useTimeZone } from '@aitrack/test-fixtures';
import type { DayEntry } from 'aitrack-lib/data/types';
import { describe, expect, it } from 'vitest';

import { EMPTY_PERIOD } from '../../shared/types.js';
import { summarizeUsage } from '../usage.js';

describe('summarizeUsage', () => {
  it('builds every period and the daily series, empty where a provider has nothing', () => {
    const now = new Date(2026, 5, 15, 12);
    const summary = summarizeUsage(
      {
        providerData: {
          claude_code: new Map([
            ['2026-06-15', makeDay(100, 50, 1.5, 'claude-sonnet-4-6')],
            ['2026-06-14', makeDay(10, 5, 0.25, 'claude-sonnet-4-6')],
            ['2026-04-16', makeDay(20, 10, 0.5, 'claude-sonnet-4-6')],
          ]),
          codex: new Map([['2026-06-12', makeDay(1, 1, 0)]]),
        },
        machineData: [],
      },
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
    expect(claude?.daily).toHaveLength(30);
    expect(claude?.daily.at(-1)).toEqual({ date: '2026-06-15', costUSD: 1.5 });
    expect(summary.providers.codex?.today).toEqual(EMPTY_PERIOD);
    expect(summary.providers.cursor).toBeUndefined();
    expect(summary.machineCount).toBe(1);
    expect(summarizeUsage(null)).toEqual({ providers: {}, machineCount: 1 });
  });

  it('counts an unsynced local machine alongside persisted machines', () => {
    const summary = summarizeUsage(
      {
        providerData: {},
        machineData: [
          {
            schemaVersion: 1,
            hostname: 'remote',
            timezone: 'UTC',
            dayBucket: 'local',
            lastUpdated: '',
            days: {},
          },
        ],
        zonedSources: [
          { hostname: 'remote', timezone: 'UTC', lastUpdated: '', current: false, days: {} },
          { hostname: 'here', timezone: 'UTC', lastUpdated: '', current: true, days: {} },
        ],
      },
      new Date(2026, 5, 15, 12),
    );
    expect(summary.machineCount).toBe(2);
  });

  it('splits usage per machine and keeps live providers apart as account usage', () => {
    const now = new Date(2026, 5, 15, 12);
    const cursorDay = makeDay(5, 5, 0.5, 'auto');
    const summary = summarizeUsage(
      {
        providerData: {},
        machineData: [],
        zonedSources: [
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
        liveProviderData: { cursor: new Map([['2026-06-15', cursorDay]]) },
      },
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
      const summary = summarizeUsage(
        { machineData: [], providerData: { claude_code: new Map([[date, day]]) } },
        now,
      );
      expect(summary.providers.claude_code?.today).toMatchObject({
        tokens: 12,
        costUSD: 1,
        hasUnpricedTokens: true,
      });
      expect(summary.providers.claude_code?.daily.at(-1)).toEqual({ date, costUSD: 1 });
    });
  });
}
