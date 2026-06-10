import { describe, expect, it } from 'vitest';

import type { ProviderData } from '../../data/types.js';
import {
  activeProviderKeys,
  costColumnLabel,
  orderedProviderKeys,
  providerLabel,
  sortProviderKeys,
} from '../providers.js';

describe('provider helpers', () => {
  it('returns human-readable labels with fallback to the key', () => {
    expect(providerLabel('claude_code')).toBe('Claude Code');
    expect(providerLabel('custom_provider')).toBe('custom_provider');
  });

  it('uses Cost for cursor and Est. cost for other providers', () => {
    expect(costColumnLabel('cursor')).toBe('Cost');
    expect(costColumnLabel('claude_code', true)).toBe('EST. COST');
  });

  it('lists active providers in canonical order with extras appended', () => {
    const data: ProviderData = {
      codex: new Map([['2024-01-01', { inputTokens: 1, outputTokens: 0, byModel: {} }]]),
      custom: new Map([['2024-01-01', { inputTokens: 1, outputTokens: 0, byModel: {} }]]),
    };
    expect(activeProviderKeys(data)).toEqual(['codex', 'custom']);
  });

  it('orders known providers first and keeps unknown keys stable', () => {
    const data: ProviderData = {
      zebra: new Map(),
      claude_code: new Map(),
      codex: new Map(),
    };
    expect(orderedProviderKeys(data)).toEqual(['claude_code', 'codex', 'zebra']);
  });

  it('sorts provider keys with unknown keys alphabetically after known ones', () => {
    expect(sortProviderKeys(['zebra', 'codex', 'claude_code', 'alpha'])).toEqual([
      'claude_code',
      'codex',
      'alpha',
      'zebra',
    ]);
  });
});
