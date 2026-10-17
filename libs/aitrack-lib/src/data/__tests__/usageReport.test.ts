import { EXTREME_TIME_ZONES, makeDay, useTimeZone } from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
}));

vi.mock('../usageData.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../usageData.js')>();
  return { ...actual, loadMergedProviderData: mocks.loadMergedProviderData };
});

import { UNKNOWN_TIMEZONE, machineTimezone } from '../../timezone.js';
import type { DayEntry } from '../types.js';
import type { LoadedUsageData, ZonedUsageSource } from '../usageData.js';
import {
  buildProjectBreakdownsFromLoaded,
  buildUsageComparison,
  buildUsageReport,
  buildUsageReportFromLoaded,
  buildUsageReportsFromLoaded,
  machineZones,
  timezoneWindowNote,
} from '../usageReport.js';

const NOW = new Date('2026-06-15T10:00:00');
const TODAY = '2026-06-15';

function zoned(timezone: string, days: ZonedUsageSource['days']): ZonedUsageSource {
  return { hostname: timezone, timezone, lastUpdated: '', current: false, days };
}

function claudeDay(inputTokens: number) {
  return {
    claude_code: {
      byModel: { m: { inputTokens, outputTokens: 0 } },
      totals: { inputTokens, outputTokens: 0 },
    },
  };
}

function dayOf(models: Record<string, [number, number, number?]>): DayEntry {
  const byModel = Object.fromEntries(
    Object.entries(models).map(([model, [inputTokens, outputTokens, costUSD]]) => [
      model,
      { inputTokens, outputTokens, ...(costUSD !== undefined && { costUSD }) },
    ]),
  );
  const rows = Object.values(byModel);
  return {
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    byModel,
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
    expect(report?.totals.hasCached).toBe(false);
  });

  it('forwards cached input so the usage table can show the cache discount', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        codex: new Map([
          [
            TODAY,
            {
              inputTokens: 1_000_000,
              outputTokens: 10_000,
              cachedInputTokens: 900_000,
              costUSD: 1.6,
              byModel: {
                'gpt-6-astra': {
                  inputTokens: 1_000_000,
                  outputTokens: 10_000,
                  cachedInputTokens: 900_000,
                  costUSD: 1.6,
                },
              },
            },
          ],
        ]),
      },
      machineData: [],
    });

    const report = await buildUsageReport({ period: 'today' });
    expect(report?.providers[0]?.rows[0]).toMatchObject({
      model: 'gpt-6-astra',
      cachedInputTokens: 900_000,
      hasCached: true,
    });
    expect(report?.totals.cachedInputTokens).toBe(900_000);
    expect(report?.totals.hasCached).toBe(true);
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

  it('orders comparison rows by cost then token movement and flags cost and unpriced models', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      machineData: [],
      providerData: {
        claude_code: new Map([
          ['2026-06-15', dayOf({ A: [80, 20, 1], B: [30, 10, 5], C: [20, 10], F: [6, 4, 0.5] })],
          ['2026-06-14', dayOf({ A: [80, 20, 1], B: [5, 5, 1], D: [20, 10], G: [5, 5, 0.25] })],
        ]),
        codex: new Map([['2026-06-15', dayOf({ E: [400, 100] })]]),
      },
    });

    const result = await buildUsageComparison({ period: 'today' });

    expect(result?.comparison.models.map((model) => model.model)).toEqual([
      'B',
      'F',
      'G',
      'E',
      'C',
      'D',
      'A',
    ]);
    const byName = Object.fromEntries(
      (result?.comparison.models ?? []).map((model) => [model.model, model]),
    );
    expect(
      Object.entries(byName).map(([name, model]) => [name, model.hasCost, model.hasUnpricedTokens]),
    ).toEqual([
      ['B', true, undefined],
      ['F', true, undefined],
      ['G', true, undefined],
      ['E', false, true],
      ['C', false, true],
      ['D', false, true],
      ['A', true, undefined],
    ]);
    expect(byName.F?.tokens).toMatchObject({ previous: 0, delta: 10, percentChange: null });
    expect(byName.G?.costUSD).toMatchObject({ current: 0, delta: -0.25, percentChange: -100 });
    expect(result?.comparison.totals).toMatchObject({ hasCost: true, hasUnpricedTokens: true });

    const claude = result?.current.providers.find((provider) => provider.key === 'claude_code');
    expect(claude?.rows.map((row) => row.model)).toEqual(['B', 'A', 'F', 'C']);
    expect(claude).toMatchObject({
      subtotalTokens: 180,
      subtotalCostUSD: 6.5,
      subtotalHasCost: true,
      hasUnpricedTokens: true,
    });
    const codex = result?.current.providers.find((provider) => provider.key === 'codex');
    expect(codex).toMatchObject({ subtotalTokens: 500, subtotalHasCost: false });
    expect(result?.current.totals.tokens).toBe(680);
  });

  it('leaves unpriced and cost flags off when every model is priced', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      machineData: [],
      providerData: {
        claude_code: new Map([
          ['2026-06-15', makeDay(10, 10, 1, 'm')],
          ['2026-06-14', makeDay(10, 10, 1, 'm')],
        ]),
      },
    });
    const result = await buildUsageComparison({ period: 'today' });
    expect(result?.current.totals.hasUnpricedTokens).toBeUndefined();
    expect(result?.current.providers[0]?.hasUnpricedTokens).toBeUndefined();
    expect(result?.comparison.totals.hasUnpricedTokens).toBeUndefined();
    expect(result?.comparison.models[0]?.hasUnpricedTokens).toBeUndefined();
  });

  it.each([
    ['current', makeDay(10, 0), makeDay(10, 0, 1)],
    ['previous', makeDay(10, 0, 1), makeDay(10, 0)],
  ])(
    'flags comparison totals when only the %s window has unpriced tokens',
    async (_w, now, before) => {
      mocks.loadMergedProviderData.mockResolvedValue({
        machineData: [],
        providerData: {
          claude_code: new Map([
            ['2026-06-15', now],
            ['2026-06-14', before],
          ]),
        },
      });
      const result = await buildUsageComparison({ period: 'today' });
      expect(result?.comparison.totals.hasUnpricedTokens).toBe(true);
      expect(result?.comparison.models[0]?.hasUnpricedTokens).toBe(true);
    },
  );

  it('forwards provider selection and refresh to the loader', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);
    await buildUsageReport({ period: 'today', providers: ['codex'], refreshLive: true });
    await buildUsageComparison({ period: 'today', providers: ['codex'], refreshLive: true });
    expect(mocks.loadMergedProviderData).toHaveBeenNthCalledWith(1, {
      providers: ['codex'],
      refreshLive: true,
    });
    expect(mocks.loadMergedProviderData).toHaveBeenNthCalledWith(2, {
      providers: ['codex'],
      refreshLive: true,
    });
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

  describe('per-machine timezones', () => {
    useTimeZone('UTC');

    beforeEach(() => {
      vi.setSystemTime(new Date('2026-06-15T03:00:00Z'));
    });

    it('includes each machine on its own local today', async () => {
      mocks.loadMergedProviderData.mockResolvedValue({
        providerData: {},
        machineData: [],
        zonedSources: [
          zoned('UTC', { '2026-06-15': claudeDay(10) }),
          zoned('America/Los_Angeles', {
            '2026-06-14': claudeDay(7),
            '2026-06-15': claudeDay(100),
          }),
        ],
      });

      const report = await buildUsageReport({ period: 'today' });

      expect(report?.totals.tokens).toBe(17);
      expect(report?.timezoneNote).toContain('America/Los_Angeles');
    });

    it('compares against the previous day of each machine', async () => {
      mocks.loadMergedProviderData.mockResolvedValue({
        providerData: {},
        machineData: [],
        zonedSources: [
          zoned('UTC', { '2026-06-15': claudeDay(10), '2026-06-14': claudeDay(4) }),
          zoned('America/Los_Angeles', {
            '2026-06-14': claudeDay(7),
            '2026-06-13': claudeDay(2),
          }),
        ],
      });

      const result = await buildUsageComparison({ period: 'today' });

      expect(result?.current.totals.tokens).toBe(17);
      expect(result?.previous.totals.tokens).toBe(6);
      expect(result?.previous.timezoneNote).toBeUndefined();
    });

    it('reports the other machine zones that a relative window follows', () => {
      const viewer = machineTimezone();
      const la = zoned('America/Los_Angeles', {});
      expect(machineZones(undefined)).toEqual([]);
      expect(machineZones([zoned(viewer, {}), zoned('', {}), zoned(UNKNOWN_TIMEZONE, {})])).toEqual(
        [],
      );
      expect(machineZones([la, la, zoned('Asia/Tokyo', {})])).toEqual([
        viewer,
        'America/Los_Angeles',
        'Asia/Tokyo',
      ]);
      expect(timezoneWindowNote([la], 'today')).toBe(
        `This window follows each machine's own timezone (${viewer}, America/Los_Angeles).`,
      );
      expect(timezoneWindowNote([zoned(viewer, {})], 'today')).toBeUndefined();
      expect(timezoneWindowNote([la], 'date')).toBeUndefined();
      expect(timezoneWindowNote(undefined, 'today')).toBeUndefined();
    });

    it('serves windows listed in any order from one merge', () => {
      const days = {
        '2026-06-01': claudeDay(3),
        '2026-06-14': claudeDay(5),
        '2026-06-15': claudeDay(10),
      };
      const periods = [{ period: 'thismonth' }, { period: 'yesterday' }] as const;
      const variants: LoadedUsageData[] = [
        { providerData: {}, machineData: [], zonedSources: [zoned('UTC', days)] },
        {
          providerData: {
            claude_code: new Map([
              ['2026-06-01', makeDay(3, 0)],
              ['2026-06-14', makeDay(5, 0)],
              ['2026-06-15', makeDay(10, 0)],
            ]),
          },
          machineData: [],
        },
      ];
      for (const loaded of variants) {
        const reports = buildUsageReportsFromLoaded(loaded, [...periods]);
        expect(reports.map((report) => report.totals.tokens)).toEqual([18, 5]);
      }
    });

    it('keeps an explicit date on the stored date keys', async () => {
      mocks.loadMergedProviderData.mockResolvedValue({
        providerData: {},
        machineData: [],
        zonedSources: [
          zoned('UTC', { '2026-06-15': claudeDay(10) }),
          zoned('America/Los_Angeles', {
            '2026-06-14': claudeDay(7),
            '2026-06-15': claudeDay(100),
          }),
        ],
      });

      const report = await buildUsageReport({ period: 'date', from: '2026-06-15' });

      expect(report?.totals.tokens).toBe(110);
      expect(report?.timezoneNote).toBeUndefined();
    });

    it('builds several windows from one merge with the same numbers as one at a time', () => {
      const periods = (['today', 'yesterday', 'week', 'month'] as const).map((period) => ({
        period,
      }));
      for (const otherZone of ['UTC', 'America/Los_Angeles']) {
        const loaded: LoadedUsageData = {
          providerData: {},
          machineData: [],
          zonedSources: [
            zoned('UTC', { '2026-06-15': claudeDay(10), '2026-06-01': claudeDay(3) }),
            zoned(otherZone, { '2026-06-14': claudeDay(7), '2026-06-15': claudeDay(100) }),
          ],
        };

        expect(buildUsageReportsFromLoaded(loaded, periods)).toEqual(
          periods.map((options) => buildUsageReportFromLoaded(loaded, options)),
        );
      }
    });
  });
});

for (const zone of EXTREME_TIME_ZONES) {
  describe(`explicit report clock in ${zone}`, () => {
    useTimeZone(zone);
    it('uses one supplied instant for all calendar windows even when the wall clock differs', () => {
      const instant = new Date('2026-01-01T00:15:00Z');
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(instant);
      const loaded: LoadedUsageData = {
        machineData: [],
        providerData: { claude_code: new Map([[date, makeDay(10, 2, 1)]]) },
      };
      const reports = buildUsageReportsFromLoaded(
        loaded,
        [{ period: 'today' }, { period: 'thismonth' }],
        instant,
      );
      expect(reports.map((report) => report.totals.tokens)).toEqual([12, 12]);
      expect(reports[0]).toEqual(buildUsageReportFromLoaded(loaded, { period: 'today' }, instant));
    });
  });
}

it('retains partially priced usage within one model and across models', () => {
  const loaded: LoadedUsageData = {
    machineData: [],
    providerData: {
      claude_code: new Map([
        [
          '2026-06-15',
          {
            inputTokens: 30,
            outputTokens: 0,
            costUSD: 2,
            byModel: {
              mixed: { inputTokens: 20, outputTokens: 0, costUSD: 2, hasUnpricedTokens: true },
              unknown: { inputTokens: 10, outputTokens: 0 },
            },
          },
        ],
      ]),
    },
  };
  const report = buildUsageReportFromLoaded(loaded, { period: 'all' });
  expect(report.totals).toMatchObject({
    tokens: 30,
    costUSD: 2,
    hasCost: true,
    hasUnpricedTokens: true,
  });
  expect(report.providers[0]?.hasUnpricedTokens).toBe(true);
  expect(report.providers[0]?.rows.every((row) => row.hasUnpricedTokens)).toBe(true);
  expect(report.totals.unpricedModels).toEqual(['mixed', 'unknown']);
});

import { emptyReportMessage } from '../usageReport.js';
it('compares partial and fully unpriced models without claiming complete cost changes', async () => {
  mocks.loadMergedProviderData.mockResolvedValue({
    machineData: [],
    providerData: {
      claude_code: new Map([
        [
          '2026-06-15',
          {
            inputTokens: 10,
            outputTokens: 0,
            byModel: { unknown: { inputTokens: 10, outputTokens: 0 } },
          },
        ],
        [
          '2026-06-14',
          {
            inputTokens: 20,
            outputTokens: 0,
            costUSD: 1,
            byModel: {
              mixed: { inputTokens: 20, outputTokens: 0, costUSD: 1, hasUnpricedTokens: true },
            },
          },
        ],
      ]),
    },
  });
  const result = await buildUsageComparison({ period: 'today' }, new Date('2026-06-15T12:00:00'));
  expect(result?.comparison.totals.hasUnpricedTokens).toBe(true);
  expect(result?.comparison.models.every((model) => model.hasUnpricedTokens)).toBe(true);
  expect(emptyReportMessage(result?.current ?? null)).toBeNull();
  const empty = buildUsageReportFromLoaded(
    { machineData: [], providerData: {} },
    { period: 'all' },
  );
  expect(emptyReportMessage(empty)).toContain('No usage recorded');
  expect(emptyReportMessage(null)).toContain('No');
});

describe('project scoping', () => {
  const projectDay = {
    claude_code: {
      byModel: { m: { inputTokens: 100, outputTokens: 0, costUSD: 1 } },
      totals: { inputTokens: 100, outputTokens: 0, costUSD: 1 },
      byProject: {
        'a/one': { inputTokens: 60, outputTokens: 0, costUSD: 0.6 },
        '(no remote)': { inputTokens: 40, outputTokens: 0, costUSD: 0.4 },
      },
      byCwd: { '/w/loose': { inputTokens: 40, outputTokens: 0, costUSD: 0.4 } },
    },
  };
  const loaded: LoadedUsageData = {
    providerData: {},
    machineData: [],
    zonedSources: [
      zoned('UTC', { '2026-06-15': projectDay, '2026-06-14': claudeDay(50) }),
      zoned('Asia/Tokyo', {}),
    ],
  };

  it('reports one project as a single model row and says what it cannot see', () => {
    const report = buildUsageReportFromLoaded(
      loaded,
      { period: 'all', project: { kind: 'project', project: 'a/one' } },
      NOW,
    );
    expect(report.providers[0]?.rows).toMatchObject([
      { model: '(all models)', tokens: 60, costUSD: 0.6 },
    ]);
    const notes = report.project?.notes.join('\n');
    expect(report.project?.label).toBe('a/one');
    expect(notes).toMatch(/Cursor.*excluded/u);
    expect(notes).toContain('Other machines count only');
    expect(notes).toContain('50 tokens in this window are not attributed');
  });

  it('marks unpriced project usage as partial without naming a model', () => {
    const unpriced = {
      ...projectDay,
      claude_code: {
        ...projectDay.claude_code,
        byProject: {
          'a/one': { inputTokens: 60, outputTokens: 0, costUSD: 0.6, hasUnpricedTokens: true },
        },
      },
    };
    const report = buildUsageReportFromLoaded(
      { ...loaded, zonedSources: [zoned('UTC', { '2026-06-15': unpriced })] },
      { period: 'all', project: { kind: 'project', project: 'a/one' } },
      NOW,
    );
    expect(report.totals.hasUnpricedTokens).toBe(true);
    expect(report.totals.unpricedModels).toBeUndefined();
  });

  it('matches a folder without a remote on this machine only', () => {
    const report = buildUsageReportFromLoaded(
      loaded,
      { period: 'all', project: { kind: 'dir', dir: '/w/loose' } },
      NOW,
    );
    const notes = report.project?.notes.join('\n');
    expect(report.totals.tokens).toBe(40);
    expect(notes).toContain('matched by working directory on this machine only');
    expect(notes).not.toContain('Other machines count only');
  });

  it('breaks every window into projects that add up to the report totals', () => {
    const options = [{ period: 'all' as const }, { period: 'date' as const, from: '2026-06-15' }];
    const breakdowns = buildProjectBreakdownsFromLoaded(loaded, options, NOW);
    const reports = buildUsageReportsFromLoaded(loaded, options, NOW);
    for (const [index, report] of reports.entries()) {
      const { projects, unattributed } = breakdowns[index] ?? { projects: [] };
      const rows = [...projects, ...(unattributed ? [unattributed] : [])];
      expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(report.totals.tokens);
      expect(rows.reduce((sum, row) => sum + row.costUSD, 0)).toBeCloseTo(report.totals.costUSD);
    }
    expect(breakdowns[1]?.unattributed).toBeUndefined();
  });

  it('scopes both sides of a comparison to the project', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(loaded);
    const result = await buildUsageComparison(
      { period: 'date', from: '2026-06-15', project: { kind: 'project', project: 'a/one' } },
      NOW,
    );
    expect(result?.current.project?.label).toBe('a/one');
    expect(result?.comparison.totals.tokens).toMatchObject({ current: 60, previous: 0 });
  });
});
