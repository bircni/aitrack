// Regenerate with `node --import tsx crates/core/tests/fixtures/quota/generate.ts` while the 4.x library is in the tree.
// Records 4.x's quota mappers, pacing, value parsing, JWT handling and Cursor CSV aggregation.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '../../../../../libs/aitrack-lib/src');

const dump = `
const lib = ${JSON.stringify(lib)};
const http = await import(lib + '/quota/http.ts');
const claude = await import(lib + '/quota/claude.ts');
const codex = await import(lib + '/quota/codex.ts');
const cursor = await import(lib + '/quota/cursor.ts');
const { projectPace } = await import(lib + '/quota/pacing.ts');
const jwt = await import(lib + '/readers/cursor/jwt.ts');
const { aggregateCursorCsvToDayMap } = await import(lib + '/readers/cursor/csv.ts');
const { fetchCursorUsageCsv } = await import(lib + '/readers/cursor/http.ts');
const now = new Date('2026-03-08T12:00:00.000Z');
const attempt = (f) => { try { return { ok: f() }; } catch (error) { return { error: { kind: error.kind ?? null, message: error.message } }; } };
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (payload) => 'h.' + b64(payload) + '.sig';

const instants = ['2026-03-08T13:00:00Z', '2026-03-08T13:00:00', '2026-03-08T13:00:00.5+02:00', '2026-03-08T13:00:00+0200', '2026-03-08', 'soon', 1772974800, 1772974800000, 1772974800.9, '1772974800', '  ', null, true, 9999999999, 10000000000];
const retryAfters = [null, '', ' ', '30', '1.2', '-5', 'Wed, 08 Mar 2026 12:01:00 GMT', 'Sun, 08 Mar 2026 12:01:00 GMT', 'garbage', '2026-03-08T12:00:30Z'];
const titles = ['pro', 'prolite_plan', '  team  plan ', 'ENTERPRISE', 'free_tier_v2', '', 'émile_x'];
const plans = [['pro', 'default_claude_max_5x'], ['max', 'default_claude_max_20x'], ['max', 'default_claude_max_5x'], ['max', undefined], ['team', 'tier_20X_x'], [undefined, 'x'], ['Pro', 'a-3x-b']];
const claudeBodies = [
  { five_hour: { utilization: 42.5, resets_at: '2026-03-08T15:00:00Z' }, seven_day: { utilization: '61', resets_at: 1773100000 }, seven_day_sonnet: { utilization: 5 } },
  { five_hour: { utilization: null }, seven_day: 'x', limits: [{ kind: 'weekly_scoped', percent: 12, resets_at: '2026-03-10T00:00:00', scope: { model: { display_name: 'Sonnet' } } }, { kind: 'weekly_scoped', percent: 30, scope: { model: { display_name: ' Fable ' } } }, { kind: 'other' }, null] },
  { extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 5000 } },
  { extra_usage: { is_enabled: true, used_credits: 900, monthly_limit: 0 } },
  { extra_usage: { is_enabled: true, used_credits: 9000, monthly_limit: 5000 } },
  { extra_usage: { is_enabled: false, used_credits: 900 } },
  {},
];
const credentials = [
  JSON.stringify({ claudeAiOauth: { accessToken: ' tok ', expiresAt: 1773000000000, scopes: ['user:profile', 3], subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x' } }),
  JSON.stringify({ claudeAiOauth: { accessToken: '' } }),
  JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: '1773000000000', scopes: 'no' } }),
  '{"claudeAiOauth":', '[]', JSON.stringify({ other: 1 }),
];
const codexAuths = [
  JSON.stringify({ tokens: { access_token: token({ exp: 1773000000, sub: 'u' }), account_id: 'acc-1' } }),
  JSON.stringify({ tokens: { access_token: token({ exp: 1773000000 }), id_token: token({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-claim' } }) } }),
  JSON.stringify({ tokens: { access_token: 'opaque', id_token: token({ chatgpt_account_id: 'acc-root' }) } }),
  JSON.stringify({ OPENAI_API_KEY: 'sk-1' }),
  JSON.stringify({ tokens: {} }),
  'nope',
];
const codexBodies = [
  { plan_type: 'prolite', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 3600 }, secondary_window: { used_percent: '20', limit_window_seconds: 604800, reset_at: 1773100000 } }, credits: { balance: '12.7' } },
  { plan_type: 'free', rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 604800, reset_after_seconds: 10.5 } }, credits: { has_credits: false } },
  { plan_type: 'PRO', rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 999 }, secondary_window: { used_percent: 2 } }, additional_rate_limits: [{ limit_name: 'GPT-5.1-Codex-Spark', rate_limit: { primary_window: { used_percent: 5, reset_at: '2026-03-08T20:00:00Z' } } }], credits: { balance: -3 } },
  { rate_limit: null, additional_rate_limits: [{ metered_feature: 'spark' }], credits: 'x' },
  {},
];
const cursorBodies = [
  [{ planUsage: { limit: 2000, totalSpend: 500, totalPercentUsed: 25, autoPercentUsed: 3, apiPercentUsed: '7' }, billingCycleStart: 1771000000000, billingCycleEnd: '1773592000000', spendLimitUsage: { individualLimit: 1000, individualRemaining: 400 } }, 'Pro'],
  [{ planUsage: { limit: 2000, remaining: 1500 }, spendLimitUsage: { pooledLimit: 5000, pooledRemaining: 5000, pooledUsed: 0, limitType: 'team' } }, 'team'],
  [{ planUsage: { totalPercentUsed: 80 }, spendLimitUsage: { totalSpend: 250 } }, undefined],
  [{ planUsage: { limit: 0, totalSpend: 10 } }, 'ultra_plan'],
  [{ enabled: false, planUsage: {} }, 'Pro'],
  [{ planUsage: { remaining: 3 } }, 'Pro'],
  [{}, 'Pro'],
];
const windows = [];
for (const used of [0, 3, 4.9, 20, 50, 89, 95, 99.4, 99.6, 120]) {
  for (const resetsIn of [null, -1, 0.5, 2, 4.5]) {
    for (const period of [0, 18000, 604800]) {
      windows.push({ usedPercent: used, resetsAt: resetsIn === null ? undefined : new Date(now.getTime() + resetsIn * 3600 * 1000).toISOString(), periodSeconds: period });
    }
  }
}
const csvs = [
  'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost\\n2026-03-07T23:30:00.000Z,claude-4.5-sonnet-thinking,"1,000",200,3000,400,4600,Free\\n2026-03-08,auto,0,10,0,0,10,$0.01\\n2026-03-08,gpt-5,0,0,0,0,"12,345",Included\\n "2026-03-08","weird, model",5,5,5,5,,x\\n2026-03-08,,1,1,1,1,,\\nbad,auto,1,1,1,1,,\\n2026-03-08,composer-2-fast,0.4,1.6,0,2.5,,\\r\\n',
  'Date,Model,Tokens\\n2026-03-06T10:00:00Z,legacy-model-latest,"2,000"\\n2026-03-06T10:00:00Z,legacy,0\\n',
  '',
];
const csvDays = (map) => [...map].map(([date, day]) => [date, Object.entries(day.byModel).map(([m, c]) => [m, c]), { inputTokens: day.inputTokens, outputTokens: day.outputTokens, costUSD: day.costUSD ?? null, hasUnpricedTokens: day.hasUnpricedTokens ?? null }]);

const calls = [];
globalThis.fetch = async (url, init) => { calls.push(Object.keys(init.headers).filter((h) => h !== 'Accept').map((h) => h + '=' + init.headers[h])); return new Response('nope', { status: 401, statusText: '' }); };
const cursorToken = token({ sub: 'user|abc', exp: 1773000000 });
let failure;
try { await fetchCursorUsageCsv(cursorToken, 'cookie-encoded:subject'); } catch (error) { failure = error.message; }

console.log(JSON.stringify({
  now: now.toISOString(),
  instants: instants.map((v) => [v, http.instantValue(v) ?? null]),
  retryAfters: retryAfters.map((v) => [v, http.parseRetryAfter(v, now.getTime()) ?? null]),
  titles: titles.map((v) => [v, http.titleCase(v)]),
  plans: plans.map(([s, t]) => [s ?? null, t ?? null, claude.formatClaudePlan(s, t) ?? null]),
  codexPlans: ['prolite', 'PRO', 'plus', ' team ', '', 3].map((v) => [v, codex.formatCodexPlan(v) ?? null]),
  claude: claudeBodies.map((body) => [body, claude.mapClaudeUsage(body, { subscriptionType: 'pro', rateLimitTier: 'default_claude_max_5x' }, now)]),
  claudeCredentials: credentials.map((text) => [text, claude.parseClaudeCredentials(text) ?? null]),
  codexAuth: codexAuths.map((text) => [text, codex.parseCodexAuth(text) ?? null]),
  codex: codexBodies.map((body) => [body, codex.mapCodexUsage(body, now)]),
  cursor: cursorBodies.map(([body, plan]) => [body, plan ?? null, attempt(() => cursor.mapCursorUsage(body, plan, now))]),
  pace: windows.map((w) => [w, projectPace(w, now.getTime())]),
  jwt: [cursorToken, token({ sub: '  ' }), 'a.b', 'a..c', 'nodots', token([1])].map((t) => [t, jwt.decodeJwtPayload(t), jwt.jwtExpiryMs(t) ?? null, jwt.jwtSubject(t) ?? null, jwt.cursorAccountId(t)]),
  csv: Object.fromEntries(['UTC', 'Pacific/Kiritimati'].map((zone) => [zone, null])),
  csvInputs: csvs,
  cursorAttempts: { calls, failure },
  csvDays: csvs.map((csv) => csvDays(aggregateCursorCsvToDayMap(csv))),
}));
`;
const home = mkdtempSync(join(tmpdir(), 'aitrack-quota-golden-'));
const script = join(home, 'dump.mts');
writeFileSync(script, dump);
const out = {};
for (const zone of ['UTC', 'Pacific/Kiritimati']) {
  const output = execFileSync(process.execPath, ['--import', 'tsx', script], {
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      TZ: zone,
      HOME: home,
      USERPROFILE: home,
      AITRACK_NO_PRICING_REFRESH: '1',
    },
  }).toString();
  out[zone] = JSON.parse(output);
}
writeFileSync(join(here, 'expected.json'), `${JSON.stringify(out)}\n`);
rmSync(home, { recursive: true, force: true });
