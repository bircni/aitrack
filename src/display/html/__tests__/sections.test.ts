import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DayEntry, ProviderData } from '../../../data/types.js';
import { buildHeatmapWeeks } from '../../heatmap/stats.js';
import { renderProviderSection, renderTodaySection } from '../sections.js';

function makeDay(input: number, output: number, costUSD?: number): DayEntry {
  return {
    inputTokens: input,
    outputTokens: output,
    ...(costUSD !== undefined && { costUSD }),
    byModel: {
      model: {
        inputTokens: input,
        outputTokens: output,
        ...(costUSD !== undefined && { costUSD }),
      },
    },
  };
}

describe('renderTodaySection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders an empty state when no provider has usage today', () => {
    const html = renderTodaySection({}, false);
    expect(html).toContain('No usage recorded yet today.');
    expect(html).toContain('2024-06-15');
  });

  it('renders provider cards sorted by cost with totals', () => {
    const providerData: ProviderData = {
      claude_code: new Map([['2024-06-15', makeDay(1000, 500, 2)]]),
      codex: new Map([['2024-06-15', makeDay(2000, 1000, 5)]]),
    };

    const html = renderTodaySection(providerData, false);
    expect(html).toContain('Codex');
    expect(html).toContain('Claude Code');
    expect(html).toContain('tokens total');
    expect(html).toContain('$7.00');
    expect(html.indexOf('Codex')).toBeLessThan(html.indexOf('Claude Code'));
  });

  it('shows em dash when a provider has no cost', () => {
    const providerData: ProviderData = {
      codex: new Map([['2024-06-15', makeDay(100, 50)]]),
    };
    const html = renderTodaySection(providerData, false);
    expect(html).toContain('—');
    expect(html).not.toContain('est. cost');
  });
});

describe('renderProviderSection', () => {
  it('renders heatmap cells, legend, and usage table', () => {
    const dayMap = new Map([
      ['2024-06-01', makeDay(1000, 500, 1.5)],
      ['2024-06-02', makeDay(2000, 1000, 3)],
    ]);
    const weeks = buildHeatmapWeeks(2024);
    const html = renderProviderSection('claude_code', dayMap, weeks, false);

    expect(html).toContain('Claude Code');
    expect(html).toContain('heatmap-grid');
    expect(html).toContain('class="cell"');
    expect(html).toContain('Usage by model');
    expect(html).toContain('$4.50');
    expect(html).toContain('LESS');
    expect(html).toContain('MORE');
  });

  it('declares the column count so a 54-week year is not clipped', () => {
    const dayMap = new Map([['2028-12-31', makeDay(1000, 500)]]);

    const ordinary = renderProviderSection('claude_code', dayMap, buildHeatmapWeeks(2027), false);
    const fiftyFour = renderProviderSection('claude_code', dayMap, buildHeatmapWeeks(2028), false);

    // The stylesheet's repeat() reads --weeks; without it the 54th column
    // landed outside the fixed 53-column template.
    expect(ordinary).toContain('--weeks:53');
    expect(fiftyFour).toContain('--weeks:54');
  });

  it('omits the usage table when there is no model activity', () => {
    const dayMap = new Map<string, DayEntry>();
    const weeks = buildHeatmapWeeks(2024);
    const html = renderProviderSection('codex', dayMap, weeks, true);

    expect(html).toContain('Codex');
    expect(html).not.toContain('Usage by model');
  });

  it('escapes tooltip content in heatmap cells', () => {
    const dayMap = new Map([['2024-06-01', makeDay(100, 50)]]);
    const weeks = buildHeatmapWeeks(2024);
    const html = renderProviderSection('claude_code', dayMap, weeks, false);
    expect(html).toContain('title="2024-06-01 — 150 tokens"');
  });
});
