import { describe, expect, it } from 'vitest';

import { resolveModelCost } from '../resolve.js';

describe('resolveModelCost', () => {
  it('returns stored costUSD in merge mode without recomputing', () => {
    const cost = resolveModelCost(
      'claude_code',
      'claude-sonnet-4-6',
      { inputTokens: 1_000_000, outputTokens: 1_000_000, costUSD: 99 },
      undefined,
      'merge',
    );
    expect(cost).toBe(99);
  });

  it('recomputes Claude cost in recompute mode from cache breakdown', () => {
    const cost = resolveModelCost(
      'claude_code',
      'claude-opus-4-7',
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        rawInputTokens: 800_000,
        cachedInputTokens: 150_000,
        cacheCreationInputTokens: 50_000,
      },
      '2026-01-01',
      'recompute',
    );
    expect(cost).toBeCloseTo(6.8875, 4);
  });

  it('estimates Claude cost from aggregate tokens in merge mode when costUSD is missing', () => {
    const cost = resolveModelCost(
      'claude_code',
      'claude-sonnet-4-6',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      undefined,
      'merge',
    );
    expect(cost).toBe(18);
  });

  it('uses stored Claude cache breakdown when backfilling a missing merge cost', () => {
    const cost = resolveModelCost(
      'claude_code',
      'claude-opus-4-7',
      {
        inputTokens: 1_100_000,
        outputTokens: 100_000,
        rawInputTokens: 100_000,
        cachedInputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
      },
      '2026-01-01',
      'merge',
    );
    expect(cost).toBeCloseTo(3.5, 5);
  });

  it('estimates Codex cost with cached input tokens', () => {
    const cost = resolveModelCost(
      'codex',
      'gpt-5.1-codex',
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 },
      undefined,
      'merge',
    );
    expect(cost).toBeCloseTo(0.6875, 4);
  });

  it('returns undefined for unknown providers', () => {
    expect(
      resolveModelCost('cursor', 'cursor-fast', { inputTokens: 100, outputTokens: 50 }),
    ).toBeUndefined();
  });
});
