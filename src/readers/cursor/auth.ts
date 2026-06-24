import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CURSOR_CONFIG_DIR_ENV = 'CURSOR_CONFIG_DIR';
const CURSOR_STATE_DB_PATH_ENV = 'CURSOR_STATE_DB_PATH';
const CURSOR_WEB_BASE_URL_ENV = 'CURSOR_WEB_BASE_URL';
const CURSOR_STATE_DB_RELATIVE_PATH = join('User', 'globalStorage', 'state.vscdb');
const CURSOR_SESSION_COOKIE_NAME = 'WorkosCursorSessionToken';

interface CursorAuthState {
  accessToken?: string;
  refreshToken?: string;
}

function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === '' ? undefined : value;
}

function getCursorDefaultStateDatabasePath(): string {
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
    const appData = environmentValue('APPDATA') ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Cursor', CURSOR_STATE_DB_RELATIVE_PATH);
  }
  const xdgConfigHome = environmentValue('XDG_CONFIG_HOME') ?? join(homedir(), '.config');
  return join(xdgConfigHome, 'Cursor', CURSOR_STATE_DB_RELATIVE_PATH);
}

function getCursorStateDatabaseCandidates(): string[] {
  const explicitDatabasePath = process.env[CURSOR_STATE_DB_PATH_ENV]?.trim();
  if (explicitDatabasePath) return [resolve(explicitDatabasePath)];

  const configuredDirectories = process.env[CURSOR_CONFIG_DIR_ENV]?.trim();
  if (!configuredDirectories) return [getCursorDefaultStateDatabasePath()];

  return configuredDirectories
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
  for (const candidate of getCursorStateDatabaseCandidates()) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeCursorDatabaseValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (value instanceof Uint8Array) {
    const trimmed = Buffer.from(value).toString('utf8').trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return undefined;
}

function readCursorAuthStateFromDatabase(databasePath: string): CursorAuthState {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const query = database.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1');
    const accessRow = query.get('cursorAuth/accessToken') as { value?: unknown } | undefined;
    const refreshRow = query.get('cursorAuth/refreshToken') as { value?: unknown } | undefined;
    return {
      accessToken: normalizeCursorDatabaseValue(accessRow?.value),
      refreshToken: normalizeCursorDatabaseValue(refreshRow?.value),
    };
  } finally {
    database.close();
  }
}

function isSqliteLockedError(error: unknown): boolean {
  return error instanceof Error && /database is locked/i.test(error.message);
}

export function errorMessage(error: unknown): string {
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

export async function readCursorAuthState(databasePath: string): Promise<CursorAuthState> {
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
  const encodedPayload = token.split('.', 2)[1];
  if (!encodedPayload) return null;
  const base64 = encodedPayload.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { sub?: string };
  } catch {
    return null;
  }
}

function getCursorWebBaseUrl(): string {
  return (environmentValue(CURSOR_WEB_BASE_URL_ENV) ?? 'https://cursor.com').replace(/\/+$/, '');
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

export async function fetchCursorUsageCsv(accessToken: string): Promise<Response> {
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
