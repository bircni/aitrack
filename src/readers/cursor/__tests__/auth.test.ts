import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  errorMessage,
  fetchCursorUsageCsv,
  getCursorStateDatabasePath,
  readCursorAuthState,
} from '../auth.js';

let tmpDir: string;
const originalFetch = fetch;

function setFetchMock(
  implementation: (...arguments_: Parameters<typeof fetch>) => Response | Promise<Response>,
): void {
  globalThis.fetch = (...arguments_) => Promise.resolve(implementation(...arguments_));
}

function resetCursorEnvironment(): void {
  delete process.env.CURSOR_CONFIG_DIR;
  delete process.env.CURSOR_STATE_DB_PATH;
  delete process.env.CURSOR_WEB_BASE_URL;
}

function createStateDatabase(path: string, rows: Record<string, string | Buffer> = {}): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  const insert = database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  database.close();
}

function jwtWithSub(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('cursor auth', () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `cursor-auth-${String(Date.now())}-${String(Math.random())}`);
    mkdirSync(tmpDir, { recursive: true });
    resetCursorEnvironment();
  });

  afterEach(() => {
    resetCursorEnvironment();
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves explicit .vscdb paths and deduplicates config dirs', () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    createStateDatabase(databasePath);
    process.env.CURSOR_STATE_DB_PATH = databasePath;

    expect(getCursorStateDatabasePath()).toBe(databasePath);

    const nested = join(tmpDir, 'profile', 'User', 'globalStorage', 'state.vscdb');
    createStateDatabase(nested);
    process.env.CURSOR_STATE_DB_PATH = '';
    process.env.CURSOR_CONFIG_DIR = `${join(tmpDir, 'profile')}, ${join(tmpDir, 'profile')}`;

    expect(getCursorStateDatabasePath()).toBe(nested);
  });

  it('returns null when no configured Cursor state database exists', () => {
    process.env.CURSOR_STATE_DB_PATH = join(tmpDir, 'missing.vscdb');

    expect(getCursorStateDatabasePath()).toBeNull();
  });

  it('reads trimmed string and buffer tokens from sqlite', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    createStateDatabase(databasePath, {
      'cursorAuth/accessToken': Buffer.from(' token-a '),
      'cursorAuth/refreshToken': 'token-r',
    });

    await expect(readCursorAuthState(databasePath)).resolves.toEqual({
      accessToken: 'token-a',
      refreshToken: 'token-r',
    });
  });

  it('returns undefined tokens for blank values', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    createStateDatabase(databasePath, {
      'cursorAuth/accessToken': ' '.repeat(3),
      'cursorAuth/refreshToken': '',
    });

    await expect(readCursorAuthState(databasePath)).resolves.toEqual({
      accessToken: undefined,
      refreshToken: undefined,
    });
  });

  it('returns undefined tokens for unsupported sqlite value types', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    database
      .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('cursorAuth/accessToken', 42);
    database.close();

    await expect(readCursorAuthState(databasePath)).resolves.toEqual({
      accessToken: undefined,
      refreshToken: undefined,
    });
  });

  it('formats unknown errors', () => {
    expect(errorMessage(new Error('locked'))).toBe('locked');
    expect(errorMessage('plain')).toBe('plain');
  });

  it('returns the first successful CSV export response', async () => {
    const calls: string[] = [];
    setFetchMock((_input, init) => {
      const auth = new Headers(init?.headers).get('Authorization');
      calls.push(auth ?? 'no-auth');
      if (auth === 'Bearer good-token') {
        return new Response('csv', { status: 200 });
      }
      return new Response('nope', { status: 401, statusText: 'Unauthorized' });
    });

    process.env.CURSOR_WEB_BASE_URL = 'https://cursor.test';
    const response = await fetchCursorUsageCsv('good-token');
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe('csv');
    expect(calls[0]).toBe('Bearer good-token');
  });

  it.each([
    ['http://cursor.test', 'must use HTTPS'],
    ['https://user:password@cursor.test', 'must not contain embedded credentials'],
    ['not a URL', 'must be a valid HTTPS URL'],
  ])(
    'rejects an unsafe Cursor export endpoint %s before sending credentials',
    async (url, error) => {
      let calls = 0;
      setFetchMock(() => {
        calls++;
        return new Response('unexpected', { status: 200 });
      });
      process.env.CURSOR_WEB_BASE_URL = url;

      await expect(fetchCursorUsageCsv('secret-token')).rejects.toThrow(error);
      expect(calls).toBe(0);
    },
  );

  it('tries cookie auth when bearer fails and includes JWT subject cookies', async () => {
    const token = jwtWithSub('user-1');
    const cookieHeaders: string[] = [];
    setFetchMock((_input, init) => {
      const cookie = new Headers(init?.headers).get('Cookie');
      if (cookie) cookieHeaders.push(cookie);
      return new Response('denied', { status: 403, statusText: 'Forbidden' });
    });

    await expect(fetchCursorUsageCsv(token)).rejects.toThrow(
      'Failed to authenticate Cursor usage export',
    );
    expect(cookieHeaders.some((c) => c.includes('user-1::'))).toBe(true);
  });

  it('falls back to token-only cookies for malformed JWT payloads', async () => {
    const cookieHeaders: string[] = [];
    setFetchMock((_input, init) => {
      const cookie = new Headers(init?.headers).get('Cookie');
      if (cookie) cookieHeaders.push(cookie);
      return new Response('denied', { status: 403, statusText: 'Forbidden' });
    });

    await expect(fetchCursorUsageCsv('header.not-json.signature')).rejects.toThrow(
      'Failed to authenticate Cursor usage export',
    );
    expect(cookieHeaders).not.toHaveLength(0);
    expect(cookieHeaders.every((cookie) => !cookie.includes('::'))).toBe(true);
  });

  it('throws a summary when every auth attempt fails', async () => {
    setFetchMock(() => new Response('denied', { status: 401, statusText: 'Unauthorized' }));

    await expect(fetchCursorUsageCsv('bad-token')).rejects.toThrow('bearer: 401 Unauthorized');
  });
});
