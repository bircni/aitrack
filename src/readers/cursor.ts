/**
 * Cursor usage via local state.vscdb auth + Cursor dashboard CSV export.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { DayEntry, DayMap } from '../types.js';

const CURSOR_CONFIG_DIR_ENV = 'CURSOR_CONFIG_DIR';
const CURSOR_STATE_DB_PATH_ENV = 'CURSOR_STATE_DB_PATH';
const CURSOR_WEB_BASE_URL_ENV = 'CURSOR_WEB_BASE_URL';
const CURSOR_STATE_DB_RELATIVE_PATH = join('User', 'globalStorage', 'state.vscdb');
const CURSOR_SESSION_COOKIE_NAME = 'WorkosCursorSessionToken';

interface CursorAuthState {
  accessToken?: string;
  refreshToken?: string;
}

interface CursorCsvRow {
  Date?: string;
  Model?: string;
  Tokens?: string;
  'Input (w/ Cache Write)'?: string;
  'Input (w/o Cache Write)'?: string;
  'Cache Read'?: string;
  'Output Tokens'?: string;
  'Total Tokens'?: string;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === '' ? undefined : value;
}

function getOrCreateDay(dayMap: DayMap, date: string): DayEntry {
  let day = dayMap.get(date);
  if (day === undefined) {
    day = { inputTokens: 0, outputTokens: 0, byModel: {} };
    dayMap.set(date, day);
  }
  return day;
}

function getCursorDefaultStateDbPath(): string {
  if (process.platform === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Cursor',
      CURSOR_STATE_DB_RELATIVE_PATH,
    );
  }
  if (process.platform === 'win32') {
    const appData = envValue('APPDATA') ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Cursor', CURSOR_STATE_DB_RELATIVE_PATH);
  }
  const xdgConfigHome = envValue('XDG_CONFIG_HOME') ?? join(homedir(), '.config');
  return join(xdgConfigHome, 'Cursor', CURSOR_STATE_DB_RELATIVE_PATH);
}

function getCursorStateDbCandidates(): string[] {
  const explicitDbPath = process.env[CURSOR_STATE_DB_PATH_ENV]?.trim();
  if (explicitDbPath) return [resolve(explicitDbPath)];

  const configuredDirs = process.env[CURSOR_CONFIG_DIR_ENV]?.trim();
  if (!configuredDirs) return [getCursorDefaultStateDbPath()];

  return configuredDirs
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map((value) => {
      const resolved = resolve(value);
      return resolved.endsWith('.vscdb') ? resolved : join(resolved, CURSOR_STATE_DB_RELATIVE_PATH);
    });
}

export function getCursorStateDbPath(): string | null {
  const seen = new Set<string>();
  for (const candidate of getCursorStateDbCandidates()) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeCursorDbValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (Buffer.isBuffer(value)) {
    const trimmed = value.toString('utf8').trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return undefined;
}

function readCursorAuthStateFromDatabase(databasePath: string): CursorAuthState {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const query = database.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1');
    const accessRow = query.get('cursorAuth/accessToken') as { value?: unknown } | undefined;
    const refreshRow = query.get('cursorAuth/refreshToken') as { value?: unknown } | undefined;
    return {
      accessToken: normalizeCursorDbValue(accessRow?.value),
      refreshToken: normalizeCursorDbValue(refreshRow?.value),
    };
  } finally {
    database.close();
  }
}

function isSqliteLockedError(error: unknown): boolean {
  return error instanceof Error && /database is locked/i.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withCursorStateSnapshot<T>(
  databasePath: string,
  callback: (snapshotPath: string) => T | Promise<T>,
): Promise<T> {
  const snapshotDir = await mkdtemp(join(tmpdir(), 'aitrack-cursor-'));
  const snapshotPath = join(snapshotDir, 'state.vscdb');
  await copyFile(databasePath, snapshotPath);
  for (const suffix of ['-shm', '-wal']) {
    const companionPath = `${databasePath}${suffix}`;
    if (!existsSync(companionPath)) continue;
    await copyFile(companionPath, `${snapshotPath}${suffix}`);
  }
  try {
    return await callback(snapshotPath);
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }
}

async function readCursorAuthState(databasePath: string): Promise<CursorAuthState> {
  try {
    return readCursorAuthStateFromDatabase(databasePath);
  } catch (error) {
    if (!isSqliteLockedError(error)) throw error;
    return withCursorStateSnapshot(databasePath, (snapshotPath) =>
      readCursorAuthStateFromDatabase(snapshotPath),
    );
  }
}

function decodeJwtPayload(token: string): { sub?: string } | null {
  const encodedPayload = token.split('.')[1];
  if (!encodedPayload) return null;
  const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { sub?: string };
  } catch {
    return null;
  }
}

function getCursorWebBaseUrl(): string {
  return (envValue(CURSOR_WEB_BASE_URL_ENV) ?? 'https://cursor.com').replace(/\/+$/, '');
}

function buildCookieHeaderValue(cookieValue: string): string {
  return `${CURSOR_SESSION_COOKIE_NAME}=${cookieValue}`;
}

interface FetchAttempt {
  label: string;
  headers: Record<string, string>;
}

function getCursorFetchAttempts(accessToken: string): FetchAttempt[] {
  const attempts: FetchAttempt[] = [];
  const seen = new Set<string>();
  const subject = decodeJwtPayload(accessToken)?.sub?.trim();
  const cookieValues = [accessToken];
  if (subject) cookieValues.push(`${subject}::${accessToken}`);

  const pushAttempt = (label: string, headers: Record<string, string>) => {
    const signature = JSON.stringify({
      label,
      headers: Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
    });
    if (seen.has(signature)) return;
    seen.add(signature);
    attempts.push({ label, headers });
  };

  pushAttempt('bearer', { Authorization: `Bearer ${accessToken}` });
  for (const cookieValue of cookieValues) {
    pushAttempt('cookie', { Cookie: buildCookieHeaderValue(cookieValue) });
    pushAttempt('cookie-encoded', {
      Cookie: buildCookieHeaderValue(encodeURIComponent(cookieValue)),
    });
    pushAttempt('bearer+cookie', {
      Authorization: `Bearer ${accessToken}`,
      Cookie: buildCookieHeaderValue(cookieValue),
    });
    pushAttempt('bearer+cookie-encoded', {
      Authorization: `Bearer ${accessToken}`,
      Cookie: buildCookieHeaderValue(encodeURIComponent(cookieValue)),
    });
  }
  return attempts;
}

async function fetchCursorUsageCsv(accessToken: string): Promise<Response> {
  const url = new URL(
    '/api/dashboard/export-usage-events-csv?strategy=tokens',
    getCursorWebBaseUrl(),
  );
  const failures: Array<{ label: string; status: number; statusText: string; body: string }> = [];

  for (const attempt of getCursorFetchAttempts(accessToken)) {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8',
        ...attempt.headers,
      },
    });
    if (response.ok) return response;
    failures.push({
      label: attempt.label,
      status: response.status,
      statusText: response.statusText,
      body: (await response.text()).trim().slice(0, 200),
    });
  }

  const summary = failures
    .map((f) => {
      const line = `${f.label}: ${f.status} ${f.statusText}`.trim();
      return f.body ? `${line} (${f.body})` : line;
    })
    .join('; ');
  throw new Error(
    `Failed to authenticate Cursor usage export with local auth state from ${url.origin}. ${summary}`,
  );
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === undefined) continue;

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
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
  headers.forEach((header, index) => {
    row[header] = values[index] ?? '';
  });
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
    const dateStr = parseCursorDateString(row.Date);
    const rawModel = row.Model?.trim();
    const tokenTotals = createCursorTokenTotals(row);
    if (!dateStr || !rawModel || !tokenTotals) return;

    const model = normalizeModelName(rawModel);
    const inputTokens = tokenTotals.input;
    const outputTokens = tokenTotals.output;

    const day = getOrCreateDay(result, dateStr);
    const rec = (day.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
    rec.inputTokens += inputTokens;
    rec.outputTokens += outputTokens;
    day.inputTokens += inputTokens;
    day.outputTokens += outputTokens;
  });

  return result;
}

/**
 * Load Cursor usage from the local IDE auth DB + dashboard CSV export.
 * Returns an empty map if the DB is missing, there is no access token, or the request fails.
 */
export async function readCursorData(): Promise<DayMap> {
  const databasePath = getCursorStateDbPath();
  if (!databasePath) {
    // Cursor simply isn't installed on this machine — benign, stay quiet.
    return new Map();
  }

  let authState: CursorAuthState;
  try {
    authState = await readCursorAuthState(databasePath);
  } catch (e) {
    console.warn(`aitrack: Cursor skipped — could not read ${databasePath}: ${errorMessage(e)}`);
    return new Map();
  }

  if (!authState.accessToken) {
    console.warn('aitrack: Cursor skipped — no cursorAuth/accessToken in state.vscdb.');
    return new Map();
  }

  let response: Response;
  try {
    response = await fetchCursorUsageCsv(authState.accessToken);
  } catch (e) {
    console.warn(`aitrack: Cursor skipped — ${errorMessage(e)}`);
    return new Map();
  }

  const text = await response.text();
  const map = aggregateCursorCsvToDayMap(text);
  if (map.size === 0) {
    console.warn('aitrack: Cursor — no usage rows in CSV export.');
  }
  return map;
}
