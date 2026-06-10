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
});
