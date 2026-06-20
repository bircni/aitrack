import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  aggregateCursorCsvToDayMap,
  getCursorStateDbPath,
  parseCursorDateString,
  readCursorData,
} from '../index.js';

let tmpDir: string;
const originalFetch = globalThis.fetch;
let fetchCalls: Array<Parameters<typeof fetch>> = [];

function toUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

function setFetchMock(
  implementation: (...args: Parameters<typeof fetch>) => Promise<Response>,
): void {
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args);
    return implementation(...args);
  };
}

function resetCursorEnv(): void {
  delete process.env.CURSOR_CONFIG_DIR;
  delete process.env.CURSOR_STATE_DB_PATH;
  delete process.env.CURSOR_WEB_BASE_URL;
}

function createStateDb(path: string, rows: Record<string, string | Buffer> = {}): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  db.close();
}

describe('parseCursorDateString', () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `cursor-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    fetchCalls = [];
    resetCursorEnv();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetCursorEnv();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses ISO date-only', () => {
    expect(parseCursorDateString('2024-03-15')).toBe('2024-03-15');
  });

  it('parses timestamp-like dates and rejects blank or invalid dates', () => {
    expect(parseCursorDateString('2024-03-15T12:00:00Z')).toBe('2024-03-15');
    expect(parseCursorDateString('')).toBeNull();
    expect(parseCursorDateString('not a date')).toBeNull();
  });
});

describe('aggregateCursorCsvToDayMap', () => {
  it('aggregates rows by date and model', () => {
    const csv = [
      'Date,Model,Total Tokens,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens',
      '2024-06-01,gpt-4,1000,100,200,300,400',
      '2024-06-01,gpt-4,500,50,100,150,200',
      '2024-06-02,claude-3-opus,2000,0,800,0,1200',
    ].join('\n');

    const map = aggregateCursorCsvToDayMap(csv);

    expect(map.get('2024-06-01')?.inputTokens).toBe(900);
    expect(map.get('2024-06-01')?.outputTokens).toBe(600);
    expect(map.get('2024-06-01')?.byModel['gpt-4']).toEqual({
      inputTokens: 900,
      outputTokens: 600,
    });

    expect(map.get('2024-06-02')?.inputTokens).toBe(800);
    expect(map.get('2024-06-02')?.outputTokens).toBe(1200);
    expect(map.get('2024-06-02')?.byModel['claude-3-opus']).toEqual({
      inputTokens: 800,
      outputTokens: 1200,
    });
  });

  it('uses Tokens column when Total Tokens header is absent', () => {
    const csv = [
      'Date,Model,Tokens,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens',
      '2024-01-01,foo,42,10,20,5,7',
    ].join('\n');
    const map = aggregateCursorCsvToDayMap(csv);
    expect(map.get('2024-01-01')?.inputTokens).toBe(35);
    expect(map.get('2024-01-01')?.outputTokens).toBe(7);
  });

  it('handles quoted CSV fields, thousands separators, latest suffixes, and invalid rows', () => {
    const csv = [
      'Date,Model,Total Tokens,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens',
      '"2024-01-01","gpt, test-latest","1,000","100","200","50","25"',
      'bad-date,gpt-4,100,10,20,0,5',
      '2024-01-01,,100,10,20,0,5',
      '2024-01-01,gpt-4,0,10,20,0,5',
      '',
    ].join('\n');

    const map = aggregateCursorCsvToDayMap(csv);

    expect(map.size).toBe(1);
    expect(map.get('2024-01-01')?.byModel['gpt, test']).toEqual({
      inputTokens: 350,
      outputTokens: 25,
    });
  });
});

describe('getCursorStateDbPath', () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `cursor-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    resetCursorEnv();
  });

  afterEach(() => {
    resetCursorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses an explicit state DB path when it exists', () => {
    const dbPath = join(tmpDir, 'state.vscdb');
    createStateDb(dbPath);
    process.env.CURSOR_STATE_DB_PATH = dbPath;

    expect(getCursorStateDbPath()).toBe(dbPath);
  });

  it('resolves configured Cursor directories and skips missing candidates', () => {
    const configDir = join(tmpDir, 'cursor-config');
    const dbPath = join(configDir, 'User', 'globalStorage', 'state.vscdb');
    createStateDb(dbPath);
    process.env.CURSOR_CONFIG_DIR = `${join(tmpDir, 'missing')}, ${configDir}`;

    expect(getCursorStateDbPath()).toBe(dbPath);
  });
});

describe('readCursorData', () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `cursor-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    fetchCalls = [];
    resetCursorEnv();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetCursorEnv();
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
    const dbPath = join(tmpDir, 'state.vscdb');
    createStateDb(dbPath, { 'cursorAuth/refreshToken': 'refresh' });
    process.env.CURSOR_STATE_DB_PATH = dbPath;

    await expect(readCursorData()).resolves.toEqual(new Map());
    expect(console.warn).toHaveBeenCalledWith(
      'aitrack: Cursor skipped — no cursorAuth/accessToken in state.vscdb.',
    );
  });

  it('fetches usage CSV with the local access token and aggregates it', async () => {
    const dbPath = join(tmpDir, 'state.vscdb');
    createStateDb(dbPath, { 'cursorAuth/accessToken': Buffer.from(' access-token ') });
    process.env.CURSOR_STATE_DB_PATH = dbPath;
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
    expect(toUrl(authCall[0]).toString()).toBe(
      'https://cursor.test/api/dashboard/export-usage-events-csv?strategy=tokens',
    );
    expect(new Headers(authCall[1]?.headers).get('Authorization')).toBe('Bearer access-token');
    expect(map.get('2024-01-01')).toEqual({
      inputTokens: 35,
      outputTokens: 7,
      byModel: { 'gpt-4': { inputTokens: 35, outputTokens: 7 } },
    });
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
  });

  it('returns an empty map when authentication attempts fail', async () => {
    const dbPath = join(tmpDir, 'state.vscdb');
    createStateDb(dbPath, { 'cursorAuth/accessToken': 'access-token' });
    process.env.CURSOR_STATE_DB_PATH = dbPath;
    setFetchMock(() =>
      Promise.resolve(new Response('nope', { status: 401, statusText: 'Unauthorized' })),
    );

    await expect(readCursorData()).resolves.toEqual(new Map());
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to authenticate Cursor usage export'),
    );
  });

  it('warns when the CSV export contains no usage rows', async () => {
    const dbPath = join(tmpDir, 'state.vscdb');
    createStateDb(dbPath, { 'cursorAuth/accessToken': 'access-token' });
    process.env.CURSOR_STATE_DB_PATH = dbPath;
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
