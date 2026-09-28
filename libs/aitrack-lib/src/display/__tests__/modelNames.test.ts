import { describe, expect, it } from 'vitest';

import { displayModelName } from '../modelNames.js';

describe('displayModelName', () => {
  it('humanizes Claude and Codex IDs', () => {
    expect(displayModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(displayModelName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(displayModelName('claude-opus-4-7')).toBe('Opus 4.7');
    expect(displayModelName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(displayModelName('claude-mythos-5-1')).toBe('Mythos 5.1');
    expect(displayModelName('gpt-5.1-codex')).toBe('GPT-5.1 Codex');
    expect(displayModelName('claude-fable-5-1-thinking-high')).toBe('Fable 5.1');
    expect(displayModelName('gpt-6-astra-high')).toBe('GPT-6 Astra');
    expect(displayModelName('gpt-6-sol')).toBe('GPT-6 Sol');
    expect(displayModelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(displayModelName('unknown-thing')).toBe('unknown-thing');
    expect(displayModelName('cursor-claude-sonnet-4-5')).toBe('Sonnet 4.5');
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

  it('pretty-prints Composer, Auto, and Cursor Grok slugs', () => {
    expect(displayModelName('composer-1')).toBe('Composer 1');
    expect(displayModelName('composer-1.5')).toBe('Composer 1.5');
    expect(displayModelName('auto')).toBe('Auto');
    expect(displayModelName('cursor-grok-4.6')).toBe('Grok 4.6');
    expect(displayModelName('grok-4.6')).toBe('Grok 4.6');
    expect(displayModelName('cursor-grok-4.7')).toBe('Grok 4.7');
    expect(displayModelName('cursor-grok-4.6-xhigh-fast')).toBe('Grok 4.6');
    expect(displayModelName('cursor-grok-4.6-xhigh-fast', { effort: true })).toBe(
      'Grok 4.6 xhigh fast',
    );
    expect(displayModelName('cursor-grok-4.6-high-fast', { effort: true })).toBe(
      'Grok 4.6 high fast',
    );
  });

  it('keeps effort on table rows so Cursor variants stay distinct', () => {
    expect(displayModelName('claude-opus-4-8-thinking-medium', { effort: true })).toBe(
      'Opus 4.8 medium',
    );
    expect(displayModelName('claude-4.6-opus-high-thinking', { effort: true })).toBe(
      'Opus 4.6 high',
    );
    expect(displayModelName('gpt-5.5-high', { effort: true })).toBe('GPT-5.5 high');
    expect(displayModelName('gpt-5.3-codex-xhigh', { effort: true })).toBe('GPT-5.3 Codex xhigh');
    expect(displayModelName('gpt-5.5-extra-high-fast', { effort: true })).toBe(
      'GPT-5.5 extra high fast',
    );
    expect(displayModelName('gpt-5.5-extra-high-fast')).toBe('GPT-5.5');
    expect(displayModelName('composer-1', { effort: true })).toBe('Composer 1');
  });
});
