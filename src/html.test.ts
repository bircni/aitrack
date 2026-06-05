import { describe, expect, it } from 'vitest';
import { renderToHtml } from './html.js';
import type { DayEntry } from './types.js';

function makeDay(input: number, output: number, costUSD?: number): DayEntry {
  return {
    inputTokens: input,
    outputTokens: output,
    ...(costUSD !== undefined ? { costUSD } : {}),
    byModel: {
      model: {
        inputTokens: input,
        outputTokens: output,
        ...(costUSD !== undefined ? { costUSD } : {}),
      },
    },
  };
}

describe('renderToHtml', () => {
  it('renders provider sections with heatmap cells and stats', () => {
    const dayMap = new Map([['2024-06-01', makeDay(1000, 500, 1.5)]]);
    const html = renderToHtml(
      { claude_code: dayMap },
      {
        lastUpdated: new Date('2024-06-01T12:00:00Z'),
      },
    );

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Claude Code');
    expect(html).toContain('heatmap-grid');
    expect(html).toContain('class="cell"');
    expect(html).toContain('INPUT TOKENS');
    expect(html).toContain('1.0K');
    expect(html).toContain('$1.50');
    expect(html).toContain('Last updated:');
  });

  it('renders dark mode class on html element', () => {
    const dayMap = new Map([['2024-06-01', makeDay(100, 50)]]);
    const html = renderToHtml({ claude_code: dayMap }, { dark: true });
    expect(html).toContain('class="dark"');
    expect(html).toContain('#0d1117');
  });

  it('includes year in title when year filter is set', () => {
    const dayMap = new Map([
      ['2024-06-01', makeDay(100, 50)],
      ['2025-06-01', makeDay(900, 450)],
    ]);
    const html = renderToHtml({ claude_code: dayMap }, { year: 2024 });
    expect(html).toContain('aitrack (2024)');
    expect(html).toContain('150');
    expect(html).not.toContain('1.4K');
  });

  it('merges providers when all is true', () => {
    const html = renderToHtml(
      {
        claude_code: new Map([['2024-06-01', makeDay(100, 50)]]),
        codex: new Map([['2024-06-02', makeDay(200, 100)]]),
      },
      { all: true },
    );
    expect(html).toContain('All providers');
    expect(html).not.toContain('Claude Code');
  });

  it('renders empty state with escaped message', () => {
    const html = renderToHtml(
      {},
      {
        emptyMessage: 'No data <yet> & done',
      },
    );
    expect(html).toContain('empty-state');
    expect(html).toContain('No data &lt;yet&gt; &amp; done');
    expect(html).not.toContain('<div class="heatmap-grid">');
  });

  it('escapes provider model names in tooltips', () => {
    const dayMap = new Map([
      [
        '2024-06-01',
        {
          inputTokens: 100,
          outputTokens: 50,
          byModel: {
            'model-"x"': { inputTokens: 100, outputTokens: 50 },
          },
        },
      ],
    ]);
    const html = renderToHtml({ claude_code: dayMap }, { year: 2024 });
    expect(html).toContain('title="2024-06-01 — 150 tokens"');
  });

  it('renders a usage-by-model table with totals', () => {
    const dayMap = new Map([
      ['2024-06-01', makeDay(1_000, 500, 1.5)],
      ['2024-06-02', makeDay(2_000, 1_000, 3.0)],
    ]);
    const html = renderToHtml({ claude_code: dayMap }, { year: 2024 });
    expect(html).toContain('Usage by model');
    expect(html).toContain('<table>');
    expect(html).toContain('4.5K');
    expect(html).toContain('$4.50');
  });

  it('shows "Cost" (not "Est. cost") for cursor', () => {
    const dayMap = new Map([['2024-06-01', makeDay(1_000, 500, 2.0)]]);
    const html = renderToHtml({ cursor: dayMap }, { year: 2024 });
    expect(html).toContain('>Cost</th>');
    expect(html).not.toContain('>Est. cost</th>');
  });
});
