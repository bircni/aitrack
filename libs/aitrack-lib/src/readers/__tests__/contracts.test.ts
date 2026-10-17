import { readFileSync } from 'node:fs';

import { providerFixture, useTimeZone } from '@aitrack/test-fixtures';
import { describe, expect, it } from 'vitest';

import type { DayMap } from '../../data/types.js';
import { parseClaudeFile } from '../claude.js';
import { parseSessionFile } from '../codex.js';
import { aggregateCursorCsvToDayMap } from '../cursor/csv.js';

// Samples under test-fixtures/src/providers pin each provider's on-disk format:
// a reader change that drops a field or shifts a total fails here.
useTimeZone('UTC');

function tokens(days: DayMap): Record<string, Record<string, [number, number]>> {
  return Object.fromEntries(
    [...days].map(([date, day]) => [
      date,
      Object.fromEntries(
        Object.entries(day.byModel).map(([model, c]) => [model, [c.inputTokens, c.outputTokens]]),
      ),
    ]),
  );
}

describe('provider log format contracts', () => {
  it('Claude Code transcript: keeps the fullest duplicate and counts cache buckets as input', async () => {
    const { days } = await parseClaudeFile(providerFixture('claude-session.jsonl'));
    expect(tokens(days)).toEqual({
      '2025-03-10': {
        'claude-sonnet-4-5-20250929': [6135, 300],
        'claude-opus-4-1-20250805': [50, 300],
      },
      '2025-03-11': { 'claude-opus-4-1-20250805': [70, 100] },
    });
    expect(days.get('2025-03-10')?.byModel['claude-sonnet-4-5-20250929']).toMatchObject({
      rawInputTokens: 135,
      cachedInputTokens: 3000,
      cacheCreationInputTokens: 2000,
      cacheCreation1hInputTokens: 1000,
    });
  });

  it('Codex session: diffs cumulative totals and restarts after a counter rollback', async () => {
    const results = await parseSessionFile(providerFixture('codex-session.jsonl'));
    expect(results).toEqual([
      {
        attribution: { project: '(no remote)' },
        dateStr: '2025-03-10',
        model: 'gpt-5',
        inputTokens: 1800,
        outputTokens: 250,
        cachedInputTokens: 900,
      },
      {
        attribution: { project: '(no remote)' },
        dateStr: '2025-03-11',
        model: 'gpt-5-codex',
        inputTokens: 2500,
        outputTokens: 250,
        cachedInputTokens: 1100,
      },
    ]);
  });

  it('Cursor CSV export: sums quoted thousands-separated cells and skips empty rows', () => {
    const days = aggregateCursorCsvToDayMap(
      readFileSync(providerFixture('cursor-usage.csv'), 'utf8'),
    );
    expect(tokens(days)).toEqual({
      '2025-03-10': { 'claude-4-sonnet': [4300, 450] },
      '2025-03-11': { 'gpt-5': [750, 125] },
    });
    expect(days.get('2025-03-10')?.byModel['claude-4-sonnet']).toMatchObject({
      rawInputTokens: 300,
      cachedInputTokens: 3000,
      cacheCreationInputTokens: 1000,
    });
  });
});
