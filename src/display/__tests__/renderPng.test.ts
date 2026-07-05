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
    const buffer = renderToPng({ claude_code: dayMap }, {});
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
    expect(buffer[2]).toBe(0x4e);
    expect(buffer[3]).toBe(0x47);
  });

  it('works in dark mode', () => {
    const dayMap = new Map([['2024-01-15', makeDay(500, 250)]]);
    const buffer = renderToPng({ claude_code: dayMap }, { dark: true });
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('defaults to one section per provider for multiple providers', () => {
    const claudeMap = new Map([['2024-01-15', makeDay(100, 50)]]);
    const codexMap = new Map([['2024-01-16', makeDay(200, 100)]]);
    const buffer = renderToPng({ claude_code: claudeMap, codex: codexMap }, {});
    expect(buffer).toBeInstanceOf(Buffer);
  });

  it('handles empty provider data without crashing', () => {
    expect(() => renderToPng({}, {})).not.toThrow();
  });

  it('merges into one section when all is true', () => {
    const claudeMap = new Map([['2024-01-15', makeDay(100, 50)]]);
    const codexMap = new Map([['2024-01-16', makeDay(200, 100)]]);
    const buffer = renderToPng({ claude_code: claudeMap, codex: codexMap }, { all: true });
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
  });

  it('renders with a year filter', () => {
    const dayMap = new Map([
      ['2024-06-01', makeDay(100, 50)],
      ['2025-06-01', makeDay(200, 100)],
    ]);
    const buffer = renderToPng({ claude_code: dayMap }, { year: 2024 });
    expect(buffer[0]).toBe(0x89);
  });

  it('renders long model names without crashing (token amount moves to its own line)', () => {
    const day: DayEntry = {
      inputTokens: 5_000_000,
      outputTokens: 40_000,
      byModel: {
        'composer-2.5-fast-extra-long-name': { inputTokens: 5_000_000, outputTokens: 40_000 },
      },
    };
    const buffer = renderToPng({ cursor: new Map([['2024-03-15', day]]) }, {});
    expect(buffer[0]).toBe(0x89);
  });
});
