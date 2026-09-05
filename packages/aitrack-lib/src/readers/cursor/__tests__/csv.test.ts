import { EXTREME_TIME_ZONES, useTimeZone } from '@aitrack/test-fixtures';
import { describe, expect, it } from 'vitest';

import { aggregateCursorCsvToDayMap, parseCursorDateString } from '../csv.js';

const HEADER =
  'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens';

function makeCsv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

describe('parseCursorDateString', () => {
  it('accepts YYYY-MM-DD directly', () => {
    expect(parseCursorDateString('2024-03-15')).toBe('2024-03-15');
  });

  it('parses a locale-style date string', () => {
    const result = parseCursorDateString('March 15, 2024');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('returns null for empty string', () => {
    expect(parseCursorDateString('')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseCursorDateString(undefined)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseCursorDateString('not-a-date')).toBeNull();
  });
});

describe('aggregateCursorCsvToDayMap', () => {
  it('returns empty map for empty input', () => {
    expect(aggregateCursorCsvToDayMap('').size).toBe(0);
  });

  it('returns empty map for header-only input', () => {
    expect(aggregateCursorCsvToDayMap(HEADER).size).toBe(0);
  });

  it('parses a valid row and accumulates tokens', () => {
    const csv = makeCsv('2024-01-10,claude-3-5-sonnet,100,50,20,30,200');
    const map = aggregateCursorCsvToDayMap(csv);
    const day = map.get('2024-01-10');
    expect(day).toBeDefined();
    if (!day) return;
    expect(day.inputTokens).toBe(170); // 100+50+20
    expect(day.outputTokens).toBe(30);
  });

  it('preserves legacy rows that only expose aggregate Tokens', () => {
    const map = aggregateCursorCsvToDayMap('Date,Model,Tokens\n2024-01-10,gpt-4o,200');

    expect(map.get('2024-01-10')).toEqual({
      inputTokens: 200,
      outputTokens: 0,
      byModel: { 'gpt-4o': { inputTokens: 200, outputTokens: 0 } },
    });
  });

  it('accumulates multiple rows on the same date', () => {
    const csv = makeCsv('2024-01-10,gpt-4o,100,0,0,50,150', '2024-01-10,gpt-4o,200,0,0,100,300');
    const map = aggregateCursorCsvToDayMap(csv);
    const day = map.get('2024-01-10');
    expect(day?.inputTokens).toBe(300);
    expect(day?.outputTokens).toBe(150);
  });

  it('accumulates multiple rows across different dates', () => {
    const csv = makeCsv('2024-01-10,gpt-4o,100,0,0,50,150', '2024-01-11,gpt-4o,200,0,0,100,300');
    const map = aggregateCursorCsvToDayMap(csv);
    expect(map.size).toBe(2);
  });

  it('strips -latest suffix from model names', () => {
    const csv = makeCsv('2024-01-10,claude-3-5-sonnet-latest,100,0,0,50,150');
    const map = aggregateCursorCsvToDayMap(csv);
    const day = map.get('2024-01-10');
    expect(day?.byModel['claude-3-5-sonnet']).toBeDefined();
    expect(day?.byModel['claude-3-5-sonnet-latest']).toBeUndefined();
  });

  it('skips rows with no usable total tokens', () => {
    const csv = makeCsv('2024-01-10,gpt-4o,0,0,0,0,0');
    const map = aggregateCursorCsvToDayMap(csv);
    expect(map.size).toBe(0);
  });

  it('keeps rows whose breakdown has tokens but whose aggregate cell does not', () => {
    // The aggregate column is a fallback, not a gate: a blank or zero
    // Total Tokens used to discard the row's real per-column counts.
    const csv = makeCsv('2024-01-10,gpt-4o,100,200,50,25,', '2024-01-11,gpt-4o,100,0,0,25,0');
    const map = aggregateCursorCsvToDayMap(csv);

    expect(map.get('2024-01-10')).toEqual({
      inputTokens: 350,
      outputTokens: 25,
      byModel: { 'gpt-4o': { inputTokens: 350, outputTokens: 25 } },
    });
    expect(map.get('2024-01-11')?.inputTokens).toBe(100);
  });

  it('skips rows with invalid date', () => {
    const csv = makeCsv('not-a-date,gpt-4o,100,0,0,50,150');
    const map = aggregateCursorCsvToDayMap(csv);
    expect(map.size).toBe(0);
  });

  it('skips blank lines', () => {
    const csv = makeCsv('', '2024-01-10,gpt-4o,100,0,0,50,150', '');
    const map = aggregateCursorCsvToDayMap(csv);
    expect(map.size).toBe(1);
  });

  it('handles quoted fields containing commas', () => {
    // Model name with a comma inside quotes
    const csv = `${HEADER}\n2024-01-10,"gpt-4, turbo",100,0,0,50,150`;
    const map = aggregateCursorCsvToDayMap(csv);
    const day = map.get('2024-01-10');
    expect(day?.byModel['gpt-4, turbo']).toBeDefined();
  });

  it('handles escaped double-quotes inside quoted fields', () => {
    const csv = `${HEADER}\n2024-01-10,"model ""x""",100,0,0,50,150`;
    const map = aggregateCursorCsvToDayMap(csv);
    const day = map.get('2024-01-10');
    expect(day?.byModel['model "x"']).toBeDefined();
  });

  it('handles comma-formatted token numbers', () => {
    const csv = makeCsv('2024-01-10,gpt-4o,1000,0,0,500,1500');
    const map = aggregateCursorCsvToDayMap(csv);
    const day = map.get('2024-01-10');
    expect(day?.inputTokens).toBe(1000);
    expect(day?.outputTokens).toBe(500);
  });

  it('handles Windows-style CRLF line endings', () => {
    const csv = `${HEADER}\r\n2024-01-10,gpt-4o,100,0,0,50,150\r\n`;
    const map = aggregateCursorCsvToDayMap(csv);
    expect(map.size).toBe(1);
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
