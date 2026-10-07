import { describe, expect, it } from 'vitest';

import type { ProviderData } from '../../data/types.js';
import {
  activeProviderKeys,
  costColumnLabel,
  normalizeProviderKey,
  orderedProviderKeys,
  PROVIDERS,
  providerLabel,
  sortProviderKeys,
} from '../../providers/index.js';

describe('provider helpers', () => {
  it('returns human-readable labels with fallback to the key', () => {
    expect(providerLabel('claude_code')).toBe('Claude Code');
    expect(providerLabel('custom_provider')).toBe('custom_provider');
  });

  it('uses Est. cost for every bundled provider', () => {
    expect(costColumnLabel('cursor')).toBe('Est. cost');
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

  it('reads labels and aliases from each descriptor', () => {
    for (const { descriptor } of PROVIDERS) {
      expect(providerLabel(descriptor.key)).toBe(descriptor.label);
      expect(costColumnLabel(descriptor.key)).toBe(descriptor.costLabel);
      for (const alias of descriptor.aliases) {
        expect(normalizeProviderKey(alias.toUpperCase())).toBe(descriptor.key);
      }
    }
  });
});
