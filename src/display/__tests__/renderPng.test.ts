import { describe, expect, it } from 'vitest';

import type { DayEntry } from '../../data/types.js';
import { renderToPng } from '../renderPng.js';

function makeDay(input: number, output: number): DayEntry {
  return {
    inputTokens: input,
    outputTokens: output,
    byModel: { 'test-model': { inputTokens: input, outputTokens: output } },
  };
}

describe('renderToPng', () => {
  it('returns a valid PNG buffer', () => {
    const dayMap = new Map([['2024-01-15', makeDay(1000, 500)]]);
    const buf = renderToPng({ claude_code: dayMap }, [], {});
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  it('works in dark mode', () => {
    const dayMap = new Map([['2024-01-15', makeDay(500, 250)]]);
    const buf = renderToPng({ claude_code: dayMap }, [], { dark: true });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('defaults to one section per provider for multiple providers', () => {
    const claudeMap = new Map([['2024-01-15', makeDay(100, 50)]]);
    const codexMap = new Map([['2024-01-16', makeDay(200, 100)]]);
    const buf = renderToPng({ claude_code: claudeMap, codex: codexMap }, [], {});
    expect(buf).toBeInstanceOf(Buffer);
  });

  it('handles empty provider data without crashing', () => {
    expect(() => renderToPng({}, [], {})).not.toThrow();
  });

  it('merges into one section when all is true', () => {
    const claudeMap = new Map([['2024-01-15', makeDay(100, 50)]]);
    const codexMap = new Map([['2024-01-16', makeDay(200, 100)]]);
    const buf = renderToPng({ claude_code: claudeMap, codex: codexMap }, [], { all: true });
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
  });

  it('renders with a year filter', () => {
    const dayMap = new Map([
      ['2024-06-01', makeDay(100, 50)],
      ['2025-06-01', makeDay(200, 100)],
    ]);
    const buf = renderToPng({ claude_code: dayMap }, [], { year: 2024 });
    expect(buf[0]).toBe(0x89);
  });
});
