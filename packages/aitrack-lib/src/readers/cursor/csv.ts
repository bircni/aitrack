import { isDayKey } from '../../constants.js';
import { addModelUsage, getOrCreateDay } from '../../data/dayMap.js';
import { stripModelAliasSuffix } from '../../data/modelId.js';
import type { DayMap, TokenCounts } from '../../data/types.js';
import { estimateCursorCostUSD } from '../../pricing/cursor.js';

/** One Cursor CSV row's token buckets used for aggregation and list-price estimates. */
interface CursorTokenTotals {
  raw: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** True when the four CSV columns were present; false for a legacy Tokens-only row. */
  hasBreakdown: boolean;
}

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

/** Parse a Cursor CSV date cell to a YYYY-MM-DD local calendar day key. */
export function parseCursorDateString(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (isDayKey(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
}

function createCursorTokenTotals(row: CursorCsvRow): CursorTokenTotals | null {
  const cacheWrite = parseCursorNumber(row['Input (w/ Cache Write)']) ?? 0;
  const raw = parseCursorNumber(row['Input (w/o Cache Write)']) ?? 0;
  const cacheRead = parseCursorNumber(row['Cache Read']) ?? 0;
  const output = parseCursorNumber(row['Output Tokens']) ?? 0;

  // Prefer the breakdown. The aggregate column is only a fallback, so a row
  // whose Total Tokens cell is blank or zero still counts when the per-column
  // figures carry real usage.
  if (raw + cacheWrite + cacheRead > 0 || output > 0) {
    return { raw, cacheWrite, cacheRead, output, hasBreakdown: true };
  }

  // Older exports only expose an aggregate Tokens column. Preserve their total
  // as input when no input/output breakdown is available.
  const total = parseCursorNumber(row['Total Tokens']) ?? parseCursorNumber(row.Tokens);
  if (!total) return null;
  return { raw: total, cacheWrite: 0, cacheRead: 0, output: 0, hasBreakdown: false };
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

  processCursorCsvLines(content.split(/\r?\n/u), (row) => {
    const dateString = parseCursorDateString(row.Date);
    const rawModel = row.Model?.trim();
    const tokenTotals = createCursorTokenTotals(row);
    if (!dateString || !rawModel || !tokenTotals) return;

    const model = stripModelAliasSuffix(rawModel);
    // Ignore Cursor's Cost column: those cells are plan-included / "Free" /
    // vendor-billed amounts. Estimate API-rate dollars from the token buckets
    // when the model can be priced; otherwise leave cost unset.
    const counts: TokenCounts = {
      inputTokens: tokenTotals.raw + tokenTotals.cacheWrite + tokenTotals.cacheRead,
      outputTokens: tokenTotals.output,
      ...(tokenTotals.hasBreakdown && {
        rawInputTokens: tokenTotals.raw,
        cachedInputTokens: tokenTotals.cacheRead,
        cacheCreationInputTokens: tokenTotals.cacheWrite,
      }),
    };
    const costUSD = estimateCursorCostUSD(model, counts, dateString);
    if (costUSD !== undefined) counts.costUSD = costUSD;
    const day = getOrCreateDay(result, dateString);
    addModelUsage(day, model, counts);
  });

  return result;
}
