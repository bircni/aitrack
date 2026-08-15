import { describe, expect, it, vi } from 'vitest';

import { makeDay } from '../../../__tests__/helpers/fixtures.js';
import { renderToHtml } from '../render.js';

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
      ['2024-06-01', makeDay(1000, 500, 1.5)],
      ['2024-06-02', makeDay(2000, 1000, 3)],
    ]);
    const html = renderToHtml({ claude_code: dayMap }, { year: 2024 });
    expect(html).toContain('Usage by model');
    expect(html).toContain('<table>');
    expect(html).toContain('4.5K');
    expect(html).toContain('$4.50');
  });

  it('shows "Cost" (not "Est. cost") for cursor', () => {
    const dayMap = new Map([['2024-06-01', makeDay(1000, 500, 2)]]);
    const html = renderToHtml({ cursor: dayMap }, { year: 2024 });
    expect(html).toContain('>Cost</th>');
    expect(html).not.toContain('>Est. cost</th>');
  });

  it('adds refresh meta and page hint when refreshIntervalSeconds is set', () => {
    const dayMap = new Map([['2024-06-01', makeDay(100, 50)]]);
    const html = renderToHtml(
      { claude_code: dayMap },
      { refreshIntervalSeconds: 120, lastUpdated: new Date('2024-06-01T12:00:00Z') },
    );
    expect(html).toContain('<meta http-equiv="refresh" content="120">');
    expect(html).toContain('Auto-refreshes every 2 minutes');
    expect(html).toContain('Showing 1 provider');
  });

  it('renders daemon health and escapes the last refresh error', () => {
    const html = renderToHtml(
      { claude_code: new Map([['2024-06-01', makeDay(100, 50)]]) },
      {
        operationalStatus: {
          refreshInProgress: false,
          syncEnabled: true,
          lastRefreshSuccessAt: '2024-06-01T12:00:00.000Z',
          lastSyncSuccessAt: '2024-06-01T11:59:00.000Z',
          nextRefreshAt: '2024-06-01T12:02:00.000Z',
          lastError: {
            phase: 'refresh',
            message: 'remote <offline> & retrying',
            at: '2024-06-01T12:01:00.000Z',
          },
        },
      },
    );

    expect(html).toContain('Daemon status');
    expect(html).toContain('Degraded');
    expect(html).toContain('Last refresh:');
    expect(html).toContain('Last sync:');
    expect(html).toContain('remote &lt;offline&gt; &amp; retrying');
    expect(html).not.toContain('remote <offline>');
  });

  it('uses year-filtered data for the today section', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 5, 1, 12));
    try {
      const dayMap = new Map([
        ['2024-06-01', makeDay(100, 50)],
        ['2025-06-01', makeDay(9000, 4500)],
      ]);
      const html = renderToHtml({ claude_code: dayMap }, { year: 2024 });
      expect(html).toContain('today-section');
      expect(html).toContain('150');
      expect(html).not.toContain('13.5K');
    } finally {
      vi.useRealTimers();
    }
  });
});
