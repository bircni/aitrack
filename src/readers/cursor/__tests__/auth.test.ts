import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  errorMessage,
  fetchCursorUsageCsv,
  getCursorStateDbPath,
  readCursorAuthState,
} from '../auth.js';

let tmpDir: string;
const originalFetch = globalThis.fetch;

function setFetchMock(
  implementation: (...args: Parameters<typeof fetch>) => Response | Promise<Response>,
): void {
  globalThis.fetch = (...args) => Promise.resolve(implementation(...args));
}

function resetCursorEnv(): void {
  delete process.env.CURSOR_CONFIG_DIR;
  delete process.env.CURSOR_STATE_DB_PATH;
  delete process.env.CURSOR_WEB_BASE_URL;
}

function createStateDb(path: string, rows: Record<string, string | Buffer> = {}): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Database(path);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  db.close();
}

function jwtWithSub(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('cursor auth', () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `cursor-auth-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    resetCursorEnv();
  });

  afterEach(() => {
    resetCursorEnv();
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves explicit .vscdb paths and deduplicates config dirs', () => {
    const dbPath = join(tmpDir, 'state.vscdb');
    createStateDb(dbPath);
    process.env.CURSOR_STATE_DB_PATH = dbPath;

    expect(getCursorStateDbPath()).toBe(dbPath);

    const nested = join(tmpDir, 'profile', 'User', 'globalStorage', 'state.vscdb');
    createStateDb(nested);
    process.env.CURSOR_STATE_DB_PATH = '';
    process.env.CURSOR_CONFIG_DIR = `${join(tmpDir, 'profile')}, ${join(tmpDir, 'profile')}`;

    expect(getCursorStateDbPath()).toBe(nested);
  });

  it('reads trimmed string and buffer tokens from sqlite', async () => {
    const dbPath = join(tmpDir, 'state.vscdb');
    createStateDb(dbPath, {
      'cursorAuth/accessToken': Buffer.from(' token-a '),
      'cursorAuth/refreshToken': 'token-r',
    });

    await expect(readCursorAuthState(dbPath)).resolves.toEqual({
      accessToken: 'token-a',
      refreshToken: 'token-r',
    });
  });

  it('returns undefined tokens for blank values', async () => {
    const dbPath = join(tmpDir, 'state.vscdb');
    createStateDb(dbPath, {
      'cursorAuth/accessToken': ' '.repeat(3),
      'cursorAuth/refreshToken': '',
    });

    await expect(readCursorAuthState(dbPath)).resolves.toEqual({
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

  it('throws a summary when every auth attempt fails', async () => {
    setFetchMock(() => new Response('denied', { status: 401, statusText: 'Unauthorized' }));

    await expect(fetchCursorUsageCsv('bad-token')).rejects.toThrow('bearer: 401 Unauthorized');
  });
});
