import { getOrCreateDay } from '../../data/dayMap.js';
import type { DayMap } from '../../data/types.js';

export interface CursorCsvRow {
  Date?: string;
  Model?: string;
  Tokens?: string;
  'Input (w/ Cache Write)'?: string;
  'Input (w/o Cache Write)'?: string;
  'Cache Read'?: string;
  'Output Tokens'?: string;
  'Total Tokens'?: string;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let isInQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === undefined) continue;

    if (char === '"') {
      if (isInQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      isInQuotes = !isInQuotes;
      continue;
    }
    if (char === ',' && !isInQuotes) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function createCursorCsvRow(headers: string[], values: string[]): CursorCsvRow {
  const row: Record<string, string> = {};
  for (const [index, header] of headers.entries()) {
    row[header] = values[index] ?? '';
  }
  return row;
}

function parseCursorNumber(value?: string): number | null {
  const numeric = Number(value?.replaceAll(',', '').trim() ?? '');
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

/** Parse Cursor CSV date column to YYYY-MM-DD (local calendar day). */
export function parseCursorDateString(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function createCursorTokenTotals(row: CursorCsvRow): { input: number; output: number } | null {
  const total = parseCursorNumber(row['Total Tokens']) ?? parseCursorNumber(row.Tokens);
  if (!total) return null;

  const inputWithCacheWrite = parseCursorNumber(row['Input (w/ Cache Write)']) ?? 0;
  const inputWithoutCacheWrite = parseCursorNumber(row['Input (w/o Cache Write)']) ?? 0;
  const cacheInput = parseCursorNumber(row['Cache Read']) ?? 0;
  const outputTokens = parseCursorNumber(row['Output Tokens']) ?? 0;

  return {
    input: inputWithCacheWrite + inputWithoutCacheWrite + cacheInput,
    output: outputTokens,
  };
}

function normalizeModelName(raw: string): string {
  return raw.replace(/-latest$/, '');
}

function processCursorCsvLines(lines: Iterable<string>, onRow: (row: CursorCsvRow) => void): void {
  let headers: string[] | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const values = parseCsvLine(line);
    if (!headers) {
      headers = values;
      continue;
    }
    onRow(createCursorCsvRow(headers, values));
  }
}

/** Aggregate Cursor CSV text into a DayMap (for tests and readCursorData). */
export function aggregateCursorCsvToDayMap(content: string): DayMap {
  const result: DayMap = new Map();

  processCursorCsvLines(content.split(/\r?\n/), (row) => {
    const dateString = parseCursorDateString(row.Date);
    const rawModel = row.Model?.trim();
    const tokenTotals = createCursorTokenTotals(row);
    if (!dateString || !rawModel || !tokenTotals) return;

    const model = normalizeModelName(rawModel);
    const inputTokens = tokenTotals.input;
    const outputTokens = tokenTotals.output;

    const day = getOrCreateDay(result, dateString);
    const rec = (day.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
    rec.inputTokens += inputTokens;
    rec.outputTokens += outputTokens;
    day.inputTokens += inputTokens;
    day.outputTokens += outputTokens;
  });

  return result;
}
