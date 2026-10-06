import { describe, expect, it } from 'vitest';

import type { UsageReport } from '../../../data/usageReport.js';
import { renderUsageReportCsv } from '../report.js';

function row(model: string, input: number, output: number, cost: number | null) {
  return {
    model,
    inputTokens: input,
    outputTokens: output,
    tokens: input + output,
    cachedInputTokens: 0,
    hasCached: false,
    costUSD: cost ?? 0,
    hasCost: cost !== null,
  };
}

function report(providers: UsageReport['providers'], totals: UsageReport['totals']): UsageReport {
  return { windowLabel: 'window', providers, totals, rowCount: providers.length };
}

describe('renderUsageReportCsv', () => {
  it('emits a header, one line per provider+model, and a TOTAL row', () => {
    const csv = renderUsageReportCsv(
      report(
        [
          {
            key: 'claude_code',
            label: 'Claude Code',
            rows: [row('claude-opus-4-8', 1000, 200, 3.5)],
            subtotalTokens: 1200,
            subtotalCostUSD: 3.5,
            subtotalHasCost: true,
          },
        ],
        {
          inputTokens: 1000,
          outputTokens: 200,
          tokens: 1200,
          cachedInputTokens: 0,
          hasCached: false,
          costUSD: 3.5,
          hasCost: true,
        },
      ),
    );

    expect(csv.split('\n')).toEqual([
      'provider,model,input_tokens,cached_input_tokens,output_tokens,total_tokens,cost_usd,pricing_status',
      'Claude Code,claude-opus-4-8,1000,,200,1200,3.5000,complete',
      'TOTAL,,1000,,200,1200,3.5000,complete',
      '',
    ]);
  });

  it('leaves the cost cell blank for a provider with no known pricing', () => {
    const csv = renderUsageReportCsv(
      report(
        [
          {
            key: 'cursor',
            label: 'Cursor',
            rows: [row('auto', 500, 100, null)],
            subtotalTokens: 600,
            subtotalCostUSD: 0,
            subtotalHasCost: false,
          },
        ],
        {
          inputTokens: 500,
          outputTokens: 100,
          tokens: 600,
          cachedInputTokens: 0,
          hasCached: false,
          costUSD: 0,
          hasCost: false,
        },
      ),
    );

    expect(csv).toContain('Cursor,auto,500,,100,600,,unpriced\n');
    expect(csv.trimEnd().endsWith('TOTAL,,500,,100,600,,unpriced')).toBe(true);
  });

  it('prefixes formula-like model names so spreadsheets treat them as text', () => {
    const csv = renderUsageReportCsv(
      report(
        [
          {
            key: 'x',
            label: 'Prov',
            rows: [row('=HYPERLINK("http://x")', 1, 1, 1)],
            subtotalTokens: 2,
            subtotalCostUSD: 1,
            subtotalHasCost: true,
          },
        ],
        {
          inputTokens: 1,
          outputTokens: 1,
          tokens: 2,
          cachedInputTokens: 0,
          hasCached: false,
          costUSD: 1,
          hasCost: true,
        },
      ),
    );

    expect(csv).toContain('Prov,"\'=HYPERLINK(""http://x"")",1,,1,2,1.0000');
  });

  it('quotes a field that contains a comma', () => {
    const csv = renderUsageReportCsv(
      report(
        [
          {
            key: 'x',
            label: 'Prov, Inc',
            rows: [row('m', 1, 1, 1)],
            subtotalTokens: 2,
            subtotalCostUSD: 1,
            subtotalHasCost: true,
          },
        ],
        {
          inputTokens: 1,
          outputTokens: 1,
          tokens: 2,
          cachedInputTokens: 0,
          hasCached: false,
          costUSD: 1,
          hasCost: true,
        },
      ),
    );

    expect(csv).toContain('"Prov, Inc",m,1,,1,2,1.0000');
  });
});

it('exports explicit partial status alongside cached input and known costs', () => {
  const item = {
    ...row('mixed', 10, 2, 1),
    cachedInputTokens: 5,
    hasCached: true,
    hasUnpricedTokens: true,
  };
  const csv = renderUsageReportCsv(
    report(
      [
        {
          key: 'claude_code',
          label: 'Claude',
          rows: [item],
          subtotalTokens: 12,
          subtotalCostUSD: 1,
          subtotalHasCost: true,
          hasUnpricedTokens: true,
        },
      ],
      { ...item, tokens: 12 },
    ),
  );
  expect(csv).toContain('Claude,mixed,10,5,2,12,1.0000,partial');
  expect(csv).toContain('TOTAL,,10,5,2,12,1.0000,partial');
});
