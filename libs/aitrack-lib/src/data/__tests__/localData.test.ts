import {
  EXTREME_TIME_ZONES,
  makeMachineFile,
  makeProviderDay,
  useTimeZone,
} from '@aitrack/test-fixtures';
import { describe, expect, it, vi } from 'vitest';

import { calendarDateInTimeZone } from '../../timezone.js';
import {
  buildMachineData,
  machineHasData,
  mergePersistedDays,
  ratchetedProviderDays,
  rebucketPersistedDays,
} from '../localData.js';
import type { DayMap } from '../types.js';

const mocks = vi.hoisted(() => ({
  readClaudeData: vi.fn(),
  readCodexData: vi.fn(),
}));

vi.mock('../../readers/claude.js', () => ({ readClaudeData: mocks.readClaudeData }));
vi.mock('../../readers/codex.js', () => ({ readCodexData: mocks.readCodexData }));

const providerDay = (inputTokens: number) => ({
  byModel: { m: { inputTokens, outputTokens: 0 } },
  totals: { inputTokens, outputTokens: 0 },
});

import { buildLocalMachineFile, readLocalProviderMaps } from '../localData.js';

function dayMap(inputTokens: number, outputTokens: number): DayMap {
  return new Map([
    ['2024-01-01', { inputTokens, outputTokens, byModel: { m: { inputTokens, outputTokens } } }],
  ]);
}

describe('localData', () => {
  it('buildMachineData flattens provider day maps into a machine file', () => {
    const machine = buildMachineData('host', {
      claude_code: dayMap(10, 5),
      codex: dayMap(20, 10),
    });

    expect(machine.hostname).toBe('host');
    expect(machine.days).toMatchObject({
      '2024-01-01': {
        claude_code: { totals: { inputTokens: 10 } },
        codex: { totals: { outputTokens: 10 } },
      },
    });
  });

  it('machineHasData is false for empty days', () => {
    expect(
      machineHasData({
        schemaVersion: 2,
        hostname: 'host',
        timezone: 'UTC',
        dayBucket: 'utc',
        lastUpdated: 'now',
        days: {},
      }),
    ).toBe(false);
    expect(
      machineHasData(buildMachineData('host', { claude_code: dayMap(1, 1), codex: new Map() })),
    ).toBe(true);
  });

  it('readLocalProviderMaps reads claude and codex in parallel', async () => {
    mocks.readClaudeData.mockResolvedValue(dayMap(1, 1));
    mocks.readCodexData.mockResolvedValue(dayMap(2, 2));

    const maps = await readLocalProviderMaps();

    expect(maps.claude_code?.get('2024-01-01')?.inputTokens).toBe(1);
    expect(maps.codex?.get('2024-01-01')?.inputTokens).toBe(2);
  });

  describe('mergePersistedDays', () => {
    it('keeps persisted days that the pruned local logs no longer cover', () => {
      const persisted = {
        '2024-01-01': { claude_code: providerDay(100) },
        '2024-06-01': { claude_code: providerDay(200) },
      };
      const fresh = { '2024-06-01': { claude_code: providerDay(250) } };

      const merged = mergePersistedDays(persisted, fresh);

      expect(Object.keys(merged)).toEqual(['2024-01-01', '2024-06-01']);
      expect(merged['2024-01-01']?.claude_code?.totals.inputTokens).toBe(100);
    });

    it('prefers fresh data for a date the local logs still cover', () => {
      const merged = mergePersistedDays(
        { '2024-06-01': { claude_code: providerDay(200) } },
        { '2024-06-01': { claude_code: providerDay(250) } },
      );

      expect(merged['2024-06-01']?.claude_code?.totals.inputTokens).toBe(250);
    });

    it('keeps the persisted record for a day whose local sessions are half pruned', () => {
      // The oldest date the logs still reach: some session files for it are
      // already gone, so fresh covers the day but with fewer tokens.
      const merged = mergePersistedDays(
        { '2024-06-01': { claude_code: providerDay(200) } },
        { '2024-06-01': { claude_code: providerDay(40) } },
      );

      expect(merged['2024-06-01']?.claude_code?.totals.inputTokens).toBe(200);
    });

    it('merges providers within a shared date instead of dropping the persisted one', () => {
      const merged = mergePersistedDays(
        { '2024-06-01': { codex: providerDay(50) } },
        { '2024-06-01': { claude_code: providerDay(250) } },
      );

      expect(merged['2024-06-01']?.codex?.totals.inputTokens).toBe(50);
      expect(merged['2024-06-01']?.claude_code?.totals.inputTokens).toBe(250);
    });

    it('sorts date and provider keys so the serialized file is stable', () => {
      const merged = mergePersistedDays(
        { '2024-06-01': { codex: providerDay(1) } },
        { '2024-01-01': { codex: providerDay(1), claude_code: providerDay(1) } },
      );

      expect(Object.keys(merged)).toEqual(['2024-01-01', '2024-06-01']);
      expect(Object.keys(merged['2024-01-01'] ?? {})).toEqual(['claude_code', 'codex']);
    });

    it('counts provider-days the fresh read would not be allowed to shrink', () => {
      expect(
        ratchetedProviderDays(
          { '2024-06-01': { claude_code: providerDay(200) } },
          { '2024-06-01': { claude_code: providerDay(40) } },
        ),
      ).toBe(1);
      expect(
        ratchetedProviderDays(
          { '2024-06-01': { claude_code: providerDay(40) } },
          { '2024-06-01': { claude_code: providerDay(200) } },
        ),
      ).toBe(0);
    });

    it('returns the fresh days unchanged when nothing is persisted yet', () => {
      const fresh = { '2024-01-01': { codex: providerDay(1) } };
      expect(mergePersistedDays(null, fresh)).toEqual(fresh);
    });
  });

  it('buildLocalMachineFile uses the provided machine id', async () => {
    mocks.readClaudeData.mockResolvedValue(dayMap(5, 5));
    mocks.readCodexData.mockResolvedValue(new Map());

    const machine = await buildLocalMachineFile('work-laptop');

    expect(machine.hostname).toBe('work-laptop');
    expect(machine.days['2024-01-01']?.claude_code).toBeDefined();
  });
});

it('skips unselected provider readers while keeping default local-machine reads complete', async () => {
  vi.clearAllMocks();
  mocks.readClaudeData.mockResolvedValue(dayMap(10, 2));
  mocks.readCodexData.mockResolvedValue(dayMap(20, 3));
  expect(Object.keys(await readLocalProviderMaps(undefined, ['claude_code']))).toEqual([
    'claude_code',
  ]);
  expect(mocks.readClaudeData).toHaveBeenCalledTimes(1);
  expect(mocks.readCodexData).not.toHaveBeenCalled();
  await buildLocalMachineFile('host');
  expect(mocks.readCodexData).toHaveBeenCalledTimes(1);
});

it('writes byProject sorted, and the working directories only when asked to keep them locally', () => {
  const counts = { inputTokens: 3, outputTokens: 1, costUSD: 2 };
  const maps = {
    claude_code: new Map([
      [
        '2026-01-01',
        {
          ...counts,
          byModel: { m: counts },
          byProject: { 'z/last': counts, 'a/first': counts },
          byCwd: { '/work/loose': counts },
        },
      ],
    ]),
  };
  const synced = buildMachineData('host', maps).days['2026-01-01']?.claude_code;
  expect(Object.keys(synced?.byProject ?? {})).toEqual(['a/first', 'z/last']);
  expect(synced).not.toHaveProperty('byCwd');
  const local = buildMachineData('host', maps, { includeLocalDirs: true });
  expect(local.days['2026-01-01']?.claude_code?.byCwd).toEqual({ '/work/loose': counts });
});

it('backfills byProject onto a compacted day without undoing the compaction', () => {
  const compacted = {
    '2026-01-01': {
      claude_code: {
        byModel: { '(compacted)': { inputTokens: 5, outputTokens: 0 } },
        totals: { inputTokens: 5, outputTokens: 0 },
      },
    },
  };
  const byProject = { 'a/b': { inputTokens: 5, outputTokens: 0 } };
  const fresh = {
    '2026-01-01': { claude_code: { ...providerDay(5), byProject } },
  };
  expect(mergePersistedDays(compacted, fresh)['2026-01-01']?.claude_code).toEqual({
    ...compacted['2026-01-01'].claude_code,
    byProject,
  });
});

it('preserves token breakdowns and partial pricing when writing machine data', () => {
  const counts = {
    inputTokens: 10,
    outputTokens: 2,
    rawInputTokens: 4,
    cachedInputTokens: 3,
    cacheCreationInputTokens: 2,
    cacheCreation1hInputTokens: 1,
    costUSD: 1,
    hasUnpricedTokens: true,
  };
  const machine = buildMachineData('host', {
    claude_code: new Map([['2026-01-01', { ...counts, byModel: { mixed: counts } }]]),
  });
  expect(machine.days['2026-01-01']?.claude_code?.totals).toEqual(counts);
  expect(machine.days['2026-01-01']?.claude_code?.byModel.mixed).toEqual(counts);
});

function mergedAfterZoneChange(
  persisted: ReturnType<typeof makeMachineFile>,
  fresh: ReturnType<typeof makeMachineFile>,
) {
  const days = mergePersistedDays(rebucketPersistedDays(persisted, fresh), fresh.days);
  return Object.fromEntries(
    Object.entries(days).map(([date, providers]) => [
      date,
      providers.claude_code?.totals.inputTokens,
    ]),
  );
}

for (const zone of EXTREME_TIME_ZONES) {
  describe(`moving a machine to ${zone}`, () => {
    useTimeZone(zone);
    const instant = new Date('2026-10-01T10:30:00Z'); // A different date in each extreme zone.

    it.each(EXTREME_TIME_ZONES.filter((other) => other !== zone))(
      'counts a message near midnight once when it was bucketed in %s',
      (other) => {
        const before = calendarDateInTimeZone(other, instant) ?? '';
        const after = calendarDateInTimeZone(zone, instant) ?? '';
        expect(before).not.toBe(after);
        const persisted = makeMachineFile(
          'host',
          { [before]: { claude_code: makeProviderDay(100, 0) } },
          { timezone: other },
        );
        const fresh = buildMachineData('host', {
          claude_code: new Map([
            [
              after,
              {
                inputTokens: 100,
                outputTokens: 0,
                byModel: { m: { inputTokens: 100, outputTokens: 0 } },
              },
            ],
          ]),
        });
        expect(mergedAfterZoneChange(persisted, fresh)).toEqual({ [after]: 100 });
      },
    );
  });
}

const file = (timezone: string, tokens: Record<string, number>) =>
  makeMachineFile(
    'host',
    Object.fromEntries(
      Object.entries(tokens).map(([date, n]) => [date, { claude_code: makeProviderDay(n, 0) }]),
    ),
    { timezone },
  );

describe('rebucketPersistedDays', () => {
  it('keeps history the logs no longer reach, and the partial oldest day they still do', () => {
    const persisted = file('UTC', {
      '2026-06-01': 500,
      '2026-09-30': 80,
      '2026-10-01': 100,
      '2026-10-02': 100,
    });
    const fresh = file('Asia/Tokyo', { '2026-09-30': 10, '2026-10-01': 60, '2026-10-02': 140 });
    expect(mergedAfterZoneChange(persisted, fresh)).toEqual({
      '2026-06-01': 500,
      '2026-09-30': 80,
      '2026-10-01': 60,
      '2026-10-02': 140,
    });
  });

  it('leaves the ratchet alone when the logs hold fewer tokens than were synced', () => {
    const persisted = file('UTC', { '2026-10-01': 100, '2026-10-02': 100 });
    const fresh = file('Asia/Tokyo', { '2026-10-02': 90 });
    expect(rebucketPersistedDays(persisted, fresh)).toBe(persisted.days);
  });

  it('only applies to a recorded change of timezone', () => {
    const fresh = file('UTC', { '2026-10-02': 100 });
    for (const timezone of ['UTC', 'unknown', '']) {
      const persisted = file(timezone, { '2026-10-01': 100 });
      expect(rebucketPersistedDays(persisted, fresh)).toBe(persisted.days);
    }
  });

  it('leaves providers the logs have nothing for', () => {
    const persisted = file('UTC', { '2026-10-01': 100 });
    expect(rebucketPersistedDays(persisted, file('Asia/Tokyo', {}))).toBe(persisted.days);
  });
});
