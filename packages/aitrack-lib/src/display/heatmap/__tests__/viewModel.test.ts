import { makeDay } from '@aitrack/test-fixtures';
import { describe, expect, it } from 'vitest';

import type { DayMap } from '../../../data/types.js';
import { buildProviderSectionViewModel } from '../viewModel.js';

function statValue(cells: Array<{ label: string; value: string }>, label: string): string {
  return cells.find((cell) => cell.label === label)?.value ?? '';
}

describe('buildProviderSectionViewModel', () => {
  it('summarizes a provider into header and bottom stats', () => {
    const dayMap: DayMap = new Map([
      ['2026-01-15', makeDay(1000, 500, 1.25, 'claude-sonnet-5')],
      ['2026-01-16', makeDay(2000, 1000, 2.5, 'claude-sonnet-5')],
    ]);

    const vm = buildProviderSectionViewModel('claude_code', dayMap);

    expect(vm.name).toBe('Claude Code');
    // fmt() abbreviates large counts, which is what the heatmap renders.
    expect(statValue(vm.headerStats, 'INPUT TOKENS')).toBe('3.0K');
    expect(statValue(vm.headerStats, 'OUTPUT TOKENS')).toBe('1.5K');
    expect(statValue(vm.headerStats, 'TOTAL TOKENS')).toBe('4.5K');
    // Claude costs are computed locally, so the column says so.
    expect(vm.headerStats.some((cell) => cell.label === 'EST. COST')).toBe(true);
  });

  it('labels Cursor cost as billed rather than estimated', () => {
    const dayMap: DayMap = new Map([['2026-01-15', makeDay(10, 5, 0.5)]]);
    const vm = buildProviderSectionViewModel('cursor', dayMap);

    expect(vm.name).toBe('Cursor');
    expect(vm.headerStats.some((cell) => cell.label === 'COST')).toBe(true);
  });

  it('shows a dash where there is no cost or no model history', () => {
    const dayMap: DayMap = new Map([['2026-01-15', makeDay(10, 5)]]);
    const vm = buildProviderSectionViewModel('claude_code', dayMap);

    expect(statValue(vm.headerStats, 'EST. COST')).toBe('—');
  });

  it('reports dashes and zero streaks for a provider with no days', () => {
    const vm = buildProviderSectionViewModel('claude_code', new Map());

    expect(statValue(vm.bottomStats, 'MOST USED MODEL')).toBe('—');
    expect(statValue(vm.bottomStats, 'PEAK DAY')).toBe('—');
    expect(statValue(vm.bottomStats, 'PEAK MONTH')).toBe('—');
    expect(statValue(vm.bottomStats, 'CURRENT STREAK')).toBe('0 days');
    // Never zero: it divides the intensity scale.
    expect(vm.maxTokens).toBe(1);
  });

  it('singularizes a one-day streak', () => {
    const vm = buildProviderSectionViewModel(
      'claude_code',
      new Map([['2026-01-15', makeDay(10, 5)]]),
    );
    expect(statValue(vm.bottomStats, 'LONGEST STREAK')).toBe('1 day');
  });

  it('never returns a zero intensity scale', () => {
    // maxTokens divides the per-day intensity, so a provider whose only days
    // are empty must still come back as 1.
    const vm = buildProviderSectionViewModel(
      'claude_code',
      new Map([['2026-01-15', makeDay(0, 0)]]),
    );
    expect(vm.maxTokens).toBe(1);
  });
});
