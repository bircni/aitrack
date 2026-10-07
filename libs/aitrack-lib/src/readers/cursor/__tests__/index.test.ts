import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCursorData } from '../index.js';

let tmpDir: string;
const originalFetch = fetch;
let fetchCalls: Array<Parameters<typeof fetch>> = [];

function toUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

function setFetchMock(
  implementation: (...arguments_: Parameters<typeof fetch>) => Promise<Response>,
): void {
  globalThis.fetch = (...arguments_) => {
    fetchCalls.push(arguments_);
    return implementation(...arguments_);
  };
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

describe('readCursorData', () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `cursor-test-${String(Date.now())}-${String(Math.random())}`);
    mkdirSync(tmpDir, { recursive: true });
    fetchCalls = [];
    resetCursorEnvironment();
    // These tests exercise the live fetch/degrade paths; the CSV cache has its
    // own suite. Disabling it keeps each case independent of the last.
    process.env.AITRACK_NO_CACHE = '1';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetCursorEnvironment();
    delete process.env.AITRACK_NO_CACHE;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty map without warning when no state database exists', async () => {
    process.env.CURSOR_STATE_DB_PATH = join(tmpDir, 'missing.vscdb');

    await expect(readCursorData()).resolves.toEqual(new Map());
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns an empty map when the state database has no access token', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    createStateDatabase(databasePath, { 'cursorAuth/refreshToken': 'refresh' });
    process.env.CURSOR_STATE_DB_PATH = databasePath;

    await expect(readCursorData()).resolves.toEqual(new Map());
    expect(console.warn).toHaveBeenCalledWith(
      'aitrack: Cursor skipped — no cursorAuth/accessToken in state.vscdb.',
    );
  });

  it('fetches usage CSV with the local access token and aggregates it', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    createStateDatabase(databasePath, { 'cursorAuth/accessToken': Buffer.from(' access-token ') });
    process.env.CURSOR_STATE_DB_PATH = databasePath;
    process.env.CURSOR_WEB_BASE_URL = 'https://cursor.test/';
    setFetchMock((input) => {
      const url = toUrl(input);
      if (url.hostname === 'api2.cursor.sh') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          [
            'Date,Model,Total Tokens,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens',
            '2024-01-01,gpt-4,100,10,20,5,7',
          ].join('\n'),
          { status: 200 },
        ),
      );
    });

    const map = await readCursorData();

    const authCall = fetchCalls.find(([input]) => toUrl(input).hostname === 'cursor.test');
    expect(authCall).toBeDefined();
    if (authCall === undefined) throw new Error('expected Cursor CSV export request');
    expect(toUrl(authCall[0]).href).toBe(
      'https://cursor.test/api/dashboard/export-usage-events-csv?strategy=tokens',
    );
    expect(new Headers(authCall[1]?.headers).get('Authorization')).toBe('Bearer access-token');
    expect(authCall[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(map.get('2024-01-01')).toEqual({
      inputTokens: 35,
      outputTokens: 7,
      hasUnpricedTokens: true,
      rawInputTokens: 20,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 10,
      byModel: {
        'gpt-4': {
          inputTokens: 35,
          outputTokens: 7,
          hasUnpricedTokens: true,
          rawInputTokens: 20,
          cachedInputTokens: 5,
          cacheCreationInputTokens: 10,
        },
      },
    });
  });

  it('returns an empty map when authentication attempts fail', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    createStateDatabase(databasePath, { 'cursorAuth/accessToken': 'access-token' });
    process.env.CURSOR_STATE_DB_PATH = databasePath;
    setFetchMock(() =>
      Promise.resolve(new Response('nope', { status: 401, statusText: 'Unauthorized' })),
    );

    await expect(readCursorData()).resolves.toEqual(new Map());
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to authenticate Cursor usage export'),
    );

    const callsAfterFailure = fetchCalls.length;
    await expect(readCursorData({ maxAgeSeconds: 60 })).resolves.toEqual(new Map());
    expect(fetchCalls).toHaveLength(callsAfterFailure);
    expect(console.warn).toHaveBeenCalledWith(
      'aitrack: Cursor skipped — retrying after a failed refresh.',
    );
    await readCursorData({ maxAgeSeconds: 0 });
    expect(fetchCalls.length).toBeGreaterThan(callsAfterFailure);
  });

  it('returns an empty map when the CSV body fails mid-stream', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    createStateDatabase(databasePath, { 'cursorAuth/accessToken': 'access-token' });
    process.env.CURSOR_STATE_DB_PATH = databasePath;
    setFetchMock((input) => {
      if (toUrl(input).hostname === 'api2.cursor.sh') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      // 200, then the connection drops while the body is being read.
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error('socket hang up'));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    // Must degrade like every other Cursor failure rather than rejecting and
    // taking the whole usage run down with it.
    await expect(readCursorData()).resolves.toEqual(new Map());
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Cursor skipped'));
  });

  it('warns when the CSV export contains no usage rows', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    createStateDatabase(databasePath, { 'cursorAuth/accessToken': 'access-token' });
    process.env.CURSOR_STATE_DB_PATH = databasePath;
    setFetchMock((input) => {
      const url = toUrl(input);
      if (url.hostname === 'api2.cursor.sh') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('Date,Model,Total Tokens\n', { status: 200 }));
    });

    await expect(readCursorData()).resolves.toEqual(new Map());
    expect(console.warn).toHaveBeenCalledWith('aitrack: Cursor — no usage rows in CSV export.');
  });
});
