import { describe, expect, it } from 'vitest';

import {
  canonicalizeClaudeModelId,
  stripModelAliasSuffix,
  stripModelEffortSuffix,
  stripModelVersionSuffixes,
} from '../modelId.js';

describe('model id suffixes', () => {
  it('strips only the -latest alias for stored model keys', () => {
    expect(stripModelAliasSuffix('claude-sonnet-4-5-latest')).toBe('claude-sonnet-4-5');
    // The dated release is a distinct model, so readers keep it.
    expect(stripModelAliasSuffix('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
    expect(stripModelAliasSuffix('gpt-5.1-codex')).toBe('gpt-5.1-codex');
  });

  it('strips both alias and dated suffixes for pricing and display', () => {
    expect(stripModelVersionSuffixes('claude-sonnet-4-5-latest')).toBe('claude-sonnet-4-5');
    expect(stripModelVersionSuffixes('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(stripModelVersionSuffixes('claude-3-7-sonnet-20250219')).toBe('claude-3-7-sonnet');
  });

  it('leaves an unsuffixed id alone', () => {
    expect(stripModelVersionSuffixes('claude-opus-5')).toBe('claude-opus-5');
    expect(stripModelAliasSuffix('claude-opus-5')).toBe('claude-opus-5');
  });

  it('strips Cursor thinking and effort labels', () => {
    expect(stripModelEffortSuffix('claude-fable-5-1-thinking-high')).toBe('claude-fable-5-1');
    expect(stripModelEffortSuffix('claude-4.6-opus-high-thinking')).toBe('claude-4.6-opus');
    expect(stripModelEffortSuffix('gpt-6-astra-xhigh')).toBe('gpt-6-astra');
    expect(stripModelEffortSuffix('gpt-5.6-terra-medium')).toBe('gpt-5.6-terra');
    // Priced model variants, not effort knobs.
    expect(stripModelEffortSuffix('gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(stripModelEffortSuffix('gpt-5.5-pro')).toBe('gpt-5.5-pro');
  });

  it('canonicalizes Claude ids onto the family-first pricing key', () => {
    expect(canonicalizeClaudeModelId('claude-fable-5-1-thinking-high')).toBe('claude-fable-5-1');
    expect(canonicalizeClaudeModelId('claude-5.1-fable')).toBe('claude-fable-5-1');
    expect(canonicalizeClaudeModelId('claude-4.6-opus-high')).toBe('claude-opus-4-6');
    expect(canonicalizeClaudeModelId('claude-opus-4-7-thinking-high')).toBe('claude-opus-4-7');
    expect(canonicalizeClaudeModelId('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-3-5');
  });
});
