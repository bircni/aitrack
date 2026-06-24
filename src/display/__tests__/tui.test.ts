import { describe, expect, it } from 'vitest';

import type { DayEntry } from '../../data/types.js';
import { renderTui } from '../tui.js';

function makeDay(input: number, output: number, costUSD?: number): DayEntry {
  return {
    inputTokens: input,
    outputTokens: output,
    ...(costUSD !== undefined && { costUSD }),
    byModel: {
      model: {
        inputTokens: input,
        outputTokens: output,
        ...(costUSD !== undefined && { costUSD }),
      },
    },
  };
}

describe('renderTui', () => {
  it('renders a stats table for fixture data', () => {
    const dayMap = new Map([['2024-06-01', makeDay(1000, 500, 1.5)]]);
    const output = renderTui({ claude_code: dayMap });
    expect(output).toContain('aitrack stats');
    expect(output).toContain('Claude Code');
    expect(output).toContain('1.5K');
    expect(output).toContain('$1.50');
    expect(output).toContain('┌');
    expect(output).toContain('Peak month');
  });

  it('respects year filter via options', () => {
    const dayMap = new Map([
      ['2024-06-01', makeDay(100, 50)],
      ['2025-06-01', makeDay(900, 450)],
    ]);
    const output = renderTui({ claude_code: dayMap }, { year: 2024 });
    expect(output).toContain('aitrack stats (2024)');
    expect(output).toContain('150');
    expect(output).not.toContain('950');
  });

  it('merges providers when all is true', () => {
    const output = renderTui(
      {
        claude_code: new Map([['2024-06-01', makeDay(100, 50)]]),
        codex: new Map([['2024-06-02', makeDay(200, 100)]]),
      },
      { all: true },
    );
    expect(output).toContain('All providers');
    expect(output).not.toContain('TOTAL');
  });

  it('adds a total row for multiple providers', () => {
    const output = renderTui({
      claude_code: new Map([['2024-06-01', makeDay(100, 50)]]),
      codex: new Map([['2024-06-02', makeDay(200, 100)]]),
    });
    expect(output).toContain('TOTAL');
    expect(output).toContain('Claude Code');
    expect(output).toContain('Codex');
  });
});
