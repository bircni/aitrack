import { describe, expect, it } from 'vitest';

import { makeDay } from '../../__tests__/helpers/fixtures.js';
import { renderTui } from '../tui.js';

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

  it('counts a shared date once in the total row', () => {
    // Both providers were active on the same single calendar day, so TOTAL is
    // 1 day of usage — not one per provider.
    const output = renderTui({
      claude_code: new Map([['2024-06-01', makeDay(100, 50)]]),
      codex: new Map([['2024-06-01', makeDay(200, 100)]]),
    });

    const totalLine = output.split('\n').find((line) => line.includes('TOTAL')) ?? '';
    expect(totalLine).toMatch(/TOTAL\s*│\s*1\s*│/);
  });

  it('reports the same day count as the merged all-providers view', () => {
    const providerData = {
      claude_code: new Map([
        ['2024-06-01', makeDay(100, 50)],
        ['2024-06-02', makeDay(100, 50)],
      ]),
      codex: new Map([
        ['2024-06-02', makeDay(200, 100)],
        ['2024-06-03', makeDay(200, 100)],
      ]),
    };

    const totalLine =
      renderTui(providerData)
        .split('\n')
        .find((line) => line.includes('TOTAL')) ?? '';
    const mergedLine =
      renderTui(providerData, { all: true })
        .split('\n')
        .find((line) => line.includes('All providers')) ?? '';

    // Three distinct dates across both providers, either way you slice it.
    expect(totalLine).toMatch(/TOTAL\s*│\s*3\s*│/);
    expect(mergedLine).toMatch(/All providers\s*│\s*3\s*│/);
  });
});
