import { describe, expect, it, vi } from 'vitest';

import { buildMachineData, machineHasData, mergePersistedDays } from '../localData.js';
import type { DayMap } from '../types.js';

const mocks = vi.hoisted(() => ({
  readClaudeData: vi.fn(),
  readCodexData: vi.fn(),
}));

vi.mock('../../readers/claude.js', () => ({ readClaudeData: mocks.readClaudeData }));
vi.mock('../../readers/codex.js', () => ({ readCodexData: mocks.readCodexData }));

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
    expect(machineHasData({ hostname: 'host', lastUpdated: 'now', days: {} })).toBe(false);
    expect(
      machineHasData(buildMachineData('host', { claude_code: dayMap(1, 1), codex: new Map() })),
    ).toBe(true);
  });

  it('readLocalProviderMaps reads claude and codex in parallel', async () => {
    mocks.readClaudeData.mockResolvedValue(dayMap(1, 1));
    mocks.readCodexData.mockResolvedValue(dayMap(2, 2));

    const maps = await readLocalProviderMaps();

    expect(maps.claude_code.get('2024-01-01')?.inputTokens).toBe(1);
    expect(maps.codex.get('2024-01-01')?.inputTokens).toBe(2);
  });

  describe('mergePersistedDays', () => {
    const providerDay = (inputTokens: number) => ({
      byModel: { m: { inputTokens, outputTokens: 0 } },
      totals: { inputTokens, outputTokens: 0 },
    });

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
