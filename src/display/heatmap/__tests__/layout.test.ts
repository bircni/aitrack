import { describe, expect, it } from 'vitest';

import { makeDay } from '../../../__tests__/helpers/fixtures.js';
import type { ProviderData } from '../../../data/types.js';
import { resolveProviderLayout } from '../layout.js';

function providerData(): ProviderData {
  return {
    claude_code: new Map([
      ['2026-01-15', makeDay(10, 5)],
      ['2025-06-01', makeDay(30, 10)],
    ]),
    codex: new Map([['2026-01-15', makeDay(20, 8)]]),
  };
}

describe('resolveProviderLayout', () => {
  it('gives one row per active provider by default', () => {
    const layout = resolveProviderLayout(providerData());
    expect(layout.keys).toEqual(['claude_code', 'codex']);
    expect(Object.keys(layout.layoutData)).toEqual(['claude_code', 'codex']);
  });

  it('merges every provider into one row when `all` is set', () => {
    const layout = resolveProviderLayout(providerData(), { all: true });

    expect(layout.keys).toEqual(['all']);
    const merged = layout.layoutData.all;
    // 2026-01-15 exists in both providers and must combine, not overwrite.
    expect(merged?.get('2026-01-15')?.inputTokens).toBe(30);
    expect(merged?.get('2025-06-01')?.inputTokens).toBe(30);
  });

  it('drops days outside the requested year', () => {
    const layout = resolveProviderLayout(providerData(), { year: 2026 });
    expect([...(layout.layoutData.claude_code?.keys() ?? [])]).toEqual(['2026-01-15']);
  });

  it('returns nothing to draw when a merged year filter leaves no days', () => {
    // An empty merged map must yield no keys rather than an 'all' row with
    // nothing in it, which would render an empty heatmap frame.
    const layout = resolveProviderLayout(providerData(), { all: true, year: 1999 });
    expect(layout.keys).toEqual([]);
    expect(layout.layoutData).toEqual({});
  });

  it('omits a provider that has no days at all', () => {
    const layout = resolveProviderLayout({ claude_code: new Map(), codex: new Map() });
    expect(layout.keys).toEqual([]);
  });
});
