import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home.dir };
});

import { formatClaudePlan, mapClaudeUsage, parseClaudeCredentials } from '../claude.js';
import { formatCodexPlan, mapCodexUsage, parseCodexAuth } from '../codex.js';
import { mapCursorUsage } from '../cursor.js';
import { instantValue, numberValue, parseRetryAfter } from '../http.js';
import { fetchQuota } from '../index.js';
import type { QuotaError, QuotaResult } from '../types.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const originalFetch = fetch;
const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'CODEX_HOME',
  'CURSOR_STATE_DB_PATH',
  'CURSOR_CONFIG_DIR',
];
let tmpDir: string;
let requests: Array<{ url: string; init?: RequestInit }>;

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(payload: object): string {
  return `${encodeSegment({ alg: 'none' })}.${encodeSegment(payload)}.sig`;
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function failure(result: QuotaResult): QuotaError {
  if (result.ok) throw new Error('expected a failed quota result');
  return result.error;
}

function resetEnvironment(): void {
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
}

function respondWith(status: number, body: unknown, headers: Record<string, string> = {}): void {
  globalThis.fetch = (input, init) => {
    requests.push({ url: urlOf(input), init });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }),
    );
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `quota-${String(Date.now())}-${String(Math.random())}`);
  mkdirSync(tmpDir, { recursive: true });
  home.dir = join(tmpDir, 'home');
  resetEnvironment();
  requests = [];
});

afterEach(() => {
  resetEnvironment();
  globalThis.fetch = originalFetch;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('http helpers', () => {
  it('parses retry-after as seconds or an HTTP date', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter(new Date(NOW.getTime() + 90_000).toUTCString(), NOW.getTime())).toBe(90);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('reads numbers and instants in the shapes providers send', () => {
    expect(numberValue('42.5')).toBe(42.5);
    expect(numberValue('')).toBeUndefined();
    expect(numberValue(Number.NaN)).toBeUndefined();
    expect(instantValue('2099-06-01T12:00:00.123456')).toBe('2099-06-01T12:00:00.123Z');
    expect(instantValue('2099-06-01T12:00:00+02:00')).toBe('2099-06-01T10:00:00.000Z');
    expect(instantValue(1_780_000_000)).toBe(instantValue(1_780_000_000_000));
    expect(instantValue('garbage')).toBeUndefined();
    expect(instantValue(null)).toBeUndefined();
  });
});

describe('claude', () => {
  it('maps session, weekly, scoped and capped extra usage', () => {
    const snapshot = mapClaudeUsage(
      {
        five_hour: { utilization: 12, resets_at: '2026-06-01T15:00:00Z' },
        seven_day: { utilization: '40', resets_at: '2026-06-05T00:00:00Z' },
        seven_day_sonnet: { utilization: 3, resets_at: '2026-06-05T00:00:00Z' },
        limits: [
          { kind: 'weekly_scoped', percent: 7, scope: { model: { display_name: 'Fable' } } },
          { kind: 'weekly_scoped', percent: 8, scope: { model: { display_name: 'Fable' } } },
          { kind: 'weekly_scoped', percent: 9, scope: { model: { display_name: 'Sonnet' } } },
          { kind: 'other', percent: 1 },
        ],
        extra_usage: { is_enabled: true, used_credits: 1250, monthly_limit: 5000 },
      },
      { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
      NOW,
    );
    expect(snapshot.plan).toBe('Max 5x');
    expect(snapshot.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['session', 12],
      ['weekly', 40],
      ['model:sonnet', 3],
      ['model:fable', 7],
      ['extra', 25],
    ]);
    expect(snapshot.windows[0]).toMatchObject({ periodSeconds: 18_000, format: 'percent' });
    expect(snapshot.windows[4]).toMatchObject({ usedValue: 12.5, limitValue: 50 });
  });

  it('shows uncapped extra usage as a value', () => {
    const snapshot = mapClaudeUsage(
      { extra_usage: { is_enabled: true, used_credits: 123_456, monthly_limit: null } },
      {},
      NOW,
    );
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.values).toEqual([
      { id: 'extra', label: 'Extra usage', value: 1234.56, format: 'dollars' },
    ]);
    expect(snapshot.plan).toBeUndefined();
  });

  it('parses credentials and plan names', () => {
    expect(parseClaudeCredentials('not json')).toBeUndefined();
    expect(parseClaudeCredentials('{"claudeAiOauth":{}}')).toBeUndefined();
    expect(
      parseClaudeCredentials(
        '{"claudeAiOauth":{"accessToken":"t","expiresAt":5,"scopes":["user:profile",1]}}',
      ),
    ).toEqual({ accessToken: 't', expiresAt: 5, scopes: ['user:profile'] });
    expect(formatClaudePlan('pro')).toBe('Pro');
  });

  it('fetches with the saved OAuth token', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    writeFileSync(
      join(tmpDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', scopes: ['user:profile'] } }),
    );
    respondWith(200, { five_hour: { utilization: 3 } });
    const result = await fetchQuota('claude_code', NOW);
    expect(result).toMatchObject({ ok: true, snapshot: { provider: 'claude_code' } });
    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(requests[0]?.url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('reads only CLAUDE_CONFIG_DIR when set, and ~/.config/claude otherwise', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    mkdirSync(join(home.dir, '.config', 'claude'), { recursive: true });
    writeFileSync(
      join(home.dir, '.config', 'claude', '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"xdg"}}',
    );
    respondWith(200, {});
    // Another account's login must not stand in for the one the override points at.
    expect(await fetchQuota('claude_code', NOW)).toMatchObject({
      error: { kind: 'noCredentials' },
    });
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(await fetchQuota('claude_code', NOW)).toMatchObject({ ok: true });
    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer xdg');
  });

  it('reports missing, scope-less and expired logins without a request', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    respondWith(200, {});
    expect(await fetchQuota('claude_code', NOW)).toMatchObject({
      ok: false,
      error: { kind: 'noCredentials' },
    });
    const path = join(tmpDir, '.credentials.json');
    writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 't', scopes: [] } }));
    const scopeless = failure(await fetchQuota('claude_code', NOW));
    expect(scopeless.kind).toBe('noCredentials');
    expect(scopeless.message).toContain('user:profile');
    writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: 1 } }));
    expect(await fetchQuota('claude_code', NOW)).toMatchObject({ error: { kind: 'expired' } });
    expect(requests).toEqual([]);
  });

  it('types HTTP failures', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    writeFileSync(join(tmpDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"t"}}');
    respondWith(401, {});
    expect(await fetchQuota('claude_code', NOW)).toMatchObject({ error: { kind: 'auth' } });
    respondWith(429, {}, { 'retry-after': '120' });
    expect(await fetchQuota('claude_code', NOW)).toMatchObject({
      error: { kind: 'rateLimited', retryAfterSeconds: 120 },
    });
    respondWith(500, {});
    expect(await fetchQuota('claude_code', NOW)).toMatchObject({ error: { kind: 'network' } });
    respondWith(200, 'nope');
    expect(await fetchQuota('claude_code', NOW)).toMatchObject({
      error: { kind: 'invalidResponse' },
    });
    respondWith(200, [1]);
    expect(await fetchQuota('claude_code', NOW)).toMatchObject({
      error: { kind: 'invalidResponse' },
    });
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    const offline = failure(await fetchQuota('claude_code', NOW));
    expect(offline.kind).toBe('network');
    expect(offline.message).toContain('offline');
  });
});

describe('codex', () => {
  it('classifies windows by length and falls back to position', () => {
    const snapshot = mapCodexUsage(
      {
        plan_type: 'prolite',
        rate_limit: {
          primary_window: {
            used_percent: 60,
            limit_window_seconds: 604_800,
            reset_at: 1_780_000_000,
          },
          secondary_window: { used_percent: 10, reset_after_seconds: 3600 },
        },
        additional_rate_limits: [
          { limit_name: 'GPT-5 Spark', rate_limit: { primary_window: { used_percent: 1 } } },
        ],
        credits: { has_credits: false },
      },
      NOW,
    );
    expect(snapshot.plan).toBe('Pro 5x');
    expect(snapshot.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['weekly', 60],
      ['spark', 1],
    ]);
    expect(snapshot.windows[0]?.resetsAt).toBe(new Date(1_780_000_000_000).toISOString());
    expect(snapshot.values).toEqual([
      { id: 'credits', label: 'Credits', value: 0, format: 'count' },
    ]);
  });

  it('uses positional defaults and relative resets', () => {
    const snapshot = mapCodexUsage(
      {
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 5, reset_after_seconds: 60 },
          secondary_window: { used_percent: 20 },
        },
        credits: { balance: '12.7' },
      },
      NOW,
    );
    expect(snapshot.plan).toBe('Plus');
    expect(snapshot.windows[0]).toMatchObject({
      id: 'session',
      periodSeconds: 18_000,
      resetsAt: '2026-06-01T12:01:00.000Z',
    });
    expect(snapshot.windows[1]).toMatchObject({ id: 'weekly', periodSeconds: 604_800 });
    expect(snapshot.values[0]?.value).toBe(12);
    expect(formatCodexPlan('pro')).toBe('Pro 20x');
    expect(formatCodexPlan(undefined)).toBeUndefined();
  });

  it('parses auth.json variants', () => {
    expect(parseCodexAuth('{')).toBeUndefined();
    expect(parseCodexAuth('{}')).toBeUndefined();
    expect(parseCodexAuth('{"OPENAI_API_KEY":"sk"}')).toBe('apiKeyOnly');
    const idToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } });
    expect(
      parseCodexAuth(
        JSON.stringify({ tokens: { access_token: jwt({ exp: 10 }), id_token: idToken } }),
      ),
    ).toMatchObject({ accountId: 'acct', expiresAt: 10_000 });
  });

  it('fetches with the account header and reports API-key-only logins', async () => {
    process.env.CODEX_HOME = tmpDir;
    const path = join(tmpDir, 'auth.json');
    writeFileSync(path, '{"OPENAI_API_KEY":"sk"}');
    respondWith(200, {});
    const apiKeyOnly = failure(await fetchQuota('codex', NOW));
    expect(apiKeyOnly.kind).toBe('noCredentials');
    expect(apiKeyOnly.message).toContain('API key');
    writeFileSync(path, JSON.stringify({ tokens: { access_token: jwt({ exp: 1 }) } }));
    expect(await fetchQuota('codex', NOW)).toMatchObject({ error: { kind: 'expired' } });
    writeFileSync(path, JSON.stringify({ tokens: { access_token: 'opaque', account_id: 'a1' } }));
    expect(await fetchQuota('codex', NOW)).toMatchObject({ ok: true });
    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(requests[0]?.url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(headers['ChatGPT-Account-Id']).toBe('a1');
    rmSync(path);
    expect(await fetchQuota('codex', NOW)).toMatchObject({ error: { kind: 'noCredentials' } });
    mkdirSync(join(home.dir, '.codex'), { recursive: true });
    writeFileSync(
      join(home.dir, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'opaque' } }),
    );
    expect(await fetchQuota('codex', NOW)).toMatchObject({ error: { kind: 'noCredentials' } });
    delete process.env.CODEX_HOME;
    expect(await fetchQuota('codex', NOW)).toMatchObject({ ok: true });
  });
});

describe('cursor', () => {
  const cycle = { billingCycleStart: 1_780_000_000_000, billingCycleEnd: 1_782_592_000_000 };

  it('maps an individual plan as percentages', () => {
    const snapshot = mapCursorUsage(
      {
        ...cycle,
        planUsage: { limit: 2000, totalSpend: 500, autoPercentUsed: 10, apiPercentUsed: 30 },
        spendLimitUsage: { individualLimit: 0, individualUsed: 250 },
      },
      'pro plan',
      NOW,
    );
    expect(snapshot.plan).toBe('Pro Plan');
    expect(snapshot.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['usage', 25],
      ['auto', 10],
      ['api', 30],
    ]);
    expect(snapshot.windows[0]).toMatchObject({
      periodSeconds: 2_592_000,
      resetsAt: new Date(1_782_592_000_000).toISOString(),
    });
    expect(snapshot.values).toEqual([
      { id: 'onDemand', label: 'On-demand', value: 2.5, format: 'dollars' },
    ]);
  });

  it('maps a team plan in dollars with an on-demand cap', () => {
    const snapshot = mapCursorUsage(
      {
        planUsage: { limit: 4000, remaining: 1000, totalPercentUsed: 75 },
        spendLimitUsage: { limitType: 'team', pooledLimit: 10_000, pooledRemaining: 7500 },
      },
      undefined,
      NOW,
    );
    expect(snapshot.windows[0]).toMatchObject({
      format: 'dollars',
      usedValue: 30,
      limitValue: 40,
      periodSeconds: 2_592_000,
    });
    expect(snapshot.windows[1]).toMatchObject({ id: 'onDemand', usedValue: 25, limitValue: 100 });
  });

  it('rejects responses without plan usage', () => {
    expect(() => mapCursorUsage({ enabled: false }, undefined, NOW)).toThrow('no active');
    expect(() => mapCursorUsage({ planUsage: {} }, undefined, NOW)).toThrow('usage limit');
  });

  it('fetches with the token from state.vscdb', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    process.env.CURSOR_STATE_DB_PATH = databasePath;
    respondWith(200, {});
    expect(await fetchQuota('cursor', NOW)).toMatchObject({ error: { kind: 'noCredentials' } });

    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    const insert = database.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
    insert.run('cursorAuth/accessToken', jwt({ sub: 'u', exp: 1 }));
    expect(await fetchQuota('cursor', NOW)).toMatchObject({ error: { kind: 'expired' } });

    insert.run('cursorAuth/accessToken', jwt({ sub: 'u' }));
    database.close();
    globalThis.fetch = (input, init) => {
      requests.push({ url: urlOf(input), init });
      const body = urlOf(input).endsWith('GetPlanInfo')
        ? { planInfo: { planName: 'pro' } }
        : { planUsage: { totalPercentUsed: 5 } };
      return Promise.resolve(new Response(JSON.stringify(body)));
    };
    expect(await fetchQuota('cursor', NOW)).toMatchObject({
      ok: true,
      snapshot: { plan: 'Pro', windows: [{ usedPercent: 5 }] },
    });
    expect(requests.map((request) => request.init?.method)).toEqual(['POST', 'POST']);
    expect(await fetchQuota('cursor', NOW)).toMatchObject({ ok: true });
  });

  it('turns a mapping failure into a typed error', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    process.env.CURSOR_STATE_DB_PATH = databasePath;
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', 'opaque');
    database.close();
    respondWith(200, { enabled: false });
    expect(await fetchQuota('cursor', NOW)).toMatchObject({ error: { kind: 'invalidResponse' } });
  });
});
