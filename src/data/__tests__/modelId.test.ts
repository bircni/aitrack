import { describe, expect, it } from 'vitest';

import { stripModelAliasSuffix, stripModelVersionSuffixes } from '../modelId.js';

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
});
