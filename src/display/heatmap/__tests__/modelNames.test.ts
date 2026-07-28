import { describe, expect, it } from 'vitest';

import { displayModelName } from '../modelNames.js';

describe('displayModelName', () => {
  it('humanizes Claude and Codex IDs', () => {
    expect(displayModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(displayModelName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(displayModelName('claude-opus-4-7')).toBe('Opus 4.7');
    expect(displayModelName('gpt-5.1-codex')).toBe('GPT-5.1 Codex');
    expect(displayModelName('unknown-thing')).toBe('unknown-thing');
  });

  it('humanizes single-version Claude IDs', () => {
    expect(displayModelName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(displayModelName('claude-opus-4')).toBe('Opus 4');
  });

  it('humanizes the older version-first Claude IDs', () => {
    expect(displayModelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(displayModelName('claude-3-7-sonnet-20250219')).toBe('Sonnet 3.7');
    expect(displayModelName('claude-3-opus-20240229')).toBe('Opus 3');
    expect(displayModelName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
  });

  it('ignores a -latest alias suffix', () => {
    expect(displayModelName('claude-sonnet-4-5-latest')).toBe('Sonnet 4.5');
  });
});
