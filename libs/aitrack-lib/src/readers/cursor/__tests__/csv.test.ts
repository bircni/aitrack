import { EXTREME_TIME_ZONES, useTimeZone } from '@aitrack/test-fixtures';
import { describe, expect, it } from 'vitest';

import { aggregateCursorCsvToDayMap, parseCursorDateString } from '../csv.js';

const HEADER =
  'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens';

function makeCsv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

describe('parseCursorDateString', () => {
  it('parses a locale-style date string', () => {
    expect(parseCursorDateString('March 15, 2024')).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it.each(['', undefined, 'not-a-date'])('returns null for %j', (value) => {
    expect(parseCursorDateString(value)).toBeNull();
  });
});

describe('aggregateCursorCsvToDayMap', () => {
  it.each([
    ['empty input', '', 0],
    ['a header alone', HEADER, 0],
    [
      'rows on two dates',
      makeCsv('2024-01-10,gpt-4o,100,0,0,50,150', '2024-01-11,gpt-4o,200,0,0,100,300'),
      2,
    ],
    ['a row with no tokens', makeCsv('2024-01-10,gpt-4o,0,0,0,0,0'), 0],
    ['a row with an invalid date', makeCsv('not-a-date,gpt-4o,100,0,0,50,150'), 0],
    ['blank lines around a row', makeCsv('', '2024-01-10,gpt-4o,100,0,0,50,150', ''), 1],
    ['CRLF line endings', `${HEADER}\r\n2024-01-10,gpt-4o,100,0,0,50,150\r\n`, 1],
  ])('keeps the days with usage for %s', (_label, csv, days) => {
    expect(aggregateCursorCsvToDayMap(csv).size).toBe(days);
  });

  it('parses a valid row and accumulates tokens', () => {
    const csv = makeCsv('2024-01-10,claude-3-5-sonnet,100,50,20,30,200');
    const map = aggregateCursorCsvToDayMap(csv);
    const day = map.get('2024-01-10');
    expect(day).toBeDefined();
    if (!day) return;
    expect(day.inputTokens).toBe(170); // 100+50+20
    expect(day.outputTokens).toBe(30);
    expect(day.rawInputTokens).toBe(50);
    expect(day.cachedInputTokens).toBe(20);
    expect(day.cacheCreationInputTokens).toBe(100);
    expect(day.costUSD).toBeCloseTo(0.000981);
  });

  it('ignores provider-reported Cursor cost columns', () => {
    const map = aggregateCursorCsvToDayMap(
      [
        'Date,Model,Total Tokens,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Cost (USD)',
        '2024-01-01,gpt-4,100,10,20,5,7,$0.12',
        '2024-01-01,gpt-4,50,5,10,0,3,0.03',
        '2024-01-01,claude,100,10,20,5,7,',
      ].join('\n'),
    );

    const day = map.get('2024-01-01');
    expect(day?.costUSD).toBeUndefined();
    expect(day?.byModel['gpt-4']?.costUSD).toBeUndefined();
    expect(day?.byModel.claude?.costUSD).toBeUndefined();
    expect(day?.rawInputTokens).toBe(50);
    expect(day?.cachedInputTokens).toBe(10);
    expect(day?.cacheCreationInputTokens).toBe(25);
  });

  it('preserves legacy rows that only expose aggregate Tokens', () => {
    const map = aggregateCursorCsvToDayMap('Date,Model,Tokens\n2024-01-10,gpt-4o,200');

    expect(map.get('2024-01-10')).toEqual({
      inputTokens: 200,
      outputTokens: 0,
      hasUnpricedTokens: true,
      byModel: { 'gpt-4o': { inputTokens: 200, outputTokens: 0, hasUnpricedTokens: true } },
    });
  });

  it('accumulates multiple rows on the same date', () => {
    const csv = makeCsv('2024-01-10,gpt-4o,100,0,0,50,150', '2024-01-10,gpt-4o,200,0,0,100,300');
    const map = aggregateCursorCsvToDayMap(csv);
    const day = map.get('2024-01-10');
    expect(day?.inputTokens).toBe(300);
    expect(day?.outputTokens).toBe(150);
  });

  it('strips -latest suffix from model names', () => {
    const csv = makeCsv('2024-01-10,claude-3-5-sonnet-latest,100,0,0,50,150');
    const map = aggregateCursorCsvToDayMap(csv);
    const day = map.get('2024-01-10');
    expect(day?.byModel['claude-3-5-sonnet']).toBeDefined();
    expect(day?.byModel['claude-3-5-sonnet-latest']).toBeUndefined();
  });

  it('keeps rows whose breakdown has tokens but whose aggregate cell does not', () => {
    // The aggregate column is a fallback, not a gate: a blank or zero
    // Total Tokens used to discard the row's real per-column counts.
    const csv = makeCsv('2024-01-10,gpt-4o,100,200,50,25,', '2024-01-11,gpt-4o,100,0,0,25,0');
    const map = aggregateCursorCsvToDayMap(csv);

    expect(map.get('2024-01-10')).toEqual({
      inputTokens: 350,
      outputTokens: 25,
      hasUnpricedTokens: true,
      rawInputTokens: 200,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 100,
      byModel: {
        'gpt-4o': {
          inputTokens: 350,
          outputTokens: 25,
          hasUnpricedTokens: true,
          rawInputTokens: 200,
          cachedInputTokens: 50,
          cacheCreationInputTokens: 100,
        },
      },
    });
    expect(map.get('2024-01-11')?.inputTokens).toBe(100);
  });

  it.each([
    ['a comma', '"gpt-4, turbo"', 'gpt-4, turbo'],
    ['escaped quotes', '"model ""x"""', 'model "x"'],
  ])('reads a quoted model name with %s', (_label, cell, model) => {
    const map = aggregateCursorCsvToDayMap(makeCsv(`2024-01-10,${cell},100,0,0,50,150`));
    expect(map.get('2024-01-10')?.byModel[model]).toBeDefined();
  });

  it('reads thousands-separated token counts', () => {
    const map = aggregateCursorCsvToDayMap(makeCsv('2024-01-10,gpt-4o,"1,000",0,0,500,"1,500"'));
    expect(map.get('2024-01-10')?.inputTokens).toBe(1000);
    expect(map.get('2024-01-10')?.outputTokens).toBe(500);
  });
});

describe.each(EXTREME_TIME_ZONES)('parseCursorDateString at %s', (timeZone) => {
  useTimeZone(timeZone);

  it('passes a bare day key through untouched', () => {
    // Cursor exports this shape most of the time, and it is already a local
    // day key: reparsing it through Date would re-anchor it to UTC midnight
    // and shift it a day west of UTC.
    expect(parseCursorDateString('2024-01-10')).toBe('2024-01-10');
  });

  it('reads a full timestamp as the local day it falls on', () => {
    const iso = new Date(2024, 0, 10, 23, 30).toISOString();
    expect(parseCursorDateString(iso)).toBe('2024-01-10');
  });
});
