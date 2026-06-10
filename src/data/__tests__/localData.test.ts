import { describe, expect, it, vi } from 'vitest';

import { buildMachineData, machineHasData } from '../localData.js';
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
    expect(machine.days['2024-01-01'].claude_code.totals.inputTokens).toBe(10);
    expect(machine.days['2024-01-01'].codex.totals.outputTokens).toBe(10);
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

  it('buildLocalMachineFile uses the provided machine id', async () => {
    mocks.readClaudeData.mockResolvedValue(dayMap(5, 5));
    mocks.readCodexData.mockResolvedValue(new Map());

    const machine = await buildLocalMachineFile('work-laptop');

    expect(machine.hostname).toBe('work-laptop');
    expect(machine.days['2024-01-01'].claude_code).toBeDefined();
  });
});
