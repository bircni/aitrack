// Regenerate with `node --import tsx crates/core/tests/fixtures/usage/generate.ts` while the 4.x library is in the tree.
// Writes a data repo of machines in several zones, then records 4.x's loader, reports, comparisons,
// project breakdowns and rankings over it, with this machine's logs from the reader corpus.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '../../../../../libs/aitrack-lib/src');
const corpus = join(here, '../readers/corpus');
const fixtureHome = join(here, 'home');
const app = join(fixtureHome, '.config/aitrack');

let seed = 0x7a3c19e5;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const counts = (i: number, o: number, extra: Record<string, unknown> = {}) => ({
  inputTokens: i,
  outputTokens: o,
  ...extra,
});

const MODELS: Record<string, string[]> = {
  claude_code: ['claude-opus-4-1', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-mystery'],
  codex: ['gpt-5', 'gpt-5-mini', 'gpt-mystery'],
  zzz: ['z'],
};

function randomDays(
  count: number,
  spanDays: number,
  withProjects: boolean,
): Record<string, Record<string, unknown>> {
  const days: Record<string, Record<string, unknown>> = {};
  const end = Date.UTC(2026, 3, 7);
  for (let i = 0; i < count; i++) {
    const date = new Date(end - Math.floor(random() * spanDays) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    days[date] ??= {};
    for (const provider of Object.keys(MODELS)) {
      if (random() < 0.4) continue;
      const byModel: Record<string, Record<string, number | boolean>> = {};
      const compacted = random() < 0.1;
      for (const model of compacted
        ? ['(compacted)']
        : MODELS[provider]!.filter(() => random() < 0.6)) {
        const c: Record<string, number | boolean> = counts(
          Math.floor(random() * 90_000),
          Math.floor(random() * 9000),
        );
        if (random() < 0.7) c.rawInputTokens = Math.floor((c.inputTokens as number) / 3);
        if (random() < 0.7) c.cachedInputTokens = Math.floor((c.inputTokens as number) / 2);
        if (random() < 0.5) c.costUSD = Math.floor(random() * 4e6) / 1e6;
        if (c.costUSD !== undefined && random() < 0.15) c.hasUnpricedTokens = true;
        byModel[model] = c;
      }
      if (Object.keys(byModel).length === 0) continue;
      const totals: Record<string, number | boolean> = counts(0, 0);
      let cost = 0;
      let priced = true;
      let unpriced = false;
      for (const c of Object.values(byModel)) {
        (totals.inputTokens as number) += c.inputTokens as number;
        (totals.outputTokens as number) += c.outputTokens as number;
        for (const f of ['rawInputTokens', 'cachedInputTokens']) {
          if (c[f] !== undefined)
            totals[f] = ((totals[f] as number | undefined) ?? 0) + (c[f] as number);
        }
        if (c.costUSD === undefined) priced = false;
        else cost += c.costUSD as number;
        if (c.hasUnpricedTokens) unpriced = true;
      }
      // A stored total beside an unpriced model, which reports backfill.
      if (priced || random() < 0.3) totals.costUSD = cost;
      if (unpriced) totals.hasUnpricedTokens = true;
      const canonical = Object.fromEntries(
        [
          'inputTokens',
          'outputTokens',
          'rawInputTokens',
          'cachedInputTokens',
          'costUSD',
          'hasUnpricedTokens',
        ]
          .filter((f) => totals[f] !== undefined)
          .map((f) => [f, totals[f]]),
      );
      const entry: Record<string, unknown> = { byModel, totals: canonical };
      if (withProjects && random() < 0.7) {
        const input = canonical.inputTokens as number;
        const output = canonical.outputTokens as number;
        const share = random() < 0.3 ? 1 : 0.6;
        const project = counts(Math.floor(input * share), Math.floor(output * share));
        if (canonical.costUSD !== undefined)
          Object.assign(project, { costUSD: (canonical.costUSD as number) * share });
        entry.byProject = { [pick(['o/r', 'b/b', 'acme/widget'])]: project };
      }
      days[date][provider] = entry;
    }
  }
  return days;
}

const machine = (
  hostname: string,
  timezone: string | undefined,
  days: Record<string, unknown>,
  lastUpdated: string,
) => ({
  schemaVersion: 2,
  hostname,
  ...(timezone && { timezone }),
  dayBucket: 'local',
  lastUpdated,
  days,
});

rmSync(fixtureHome, { recursive: true, force: true });
mkdirSync(join(app, 'repo/data'), { recursive: true });
writeFileSync(
  join(app, 'config.json'),
  JSON.stringify({ repoUrl: 'git@example.com:me/data.git', machineId: 'laptop' }, null, 2),
);
const kiri = randomDays(30, 420, true);
const files: Record<string, unknown> = {
  'laptop.json': machine(
    'laptop',
    'Asia/Tokyo',
    randomDays(25, 60, true),
    '2026-04-04T08:00:00.000Z',
  ),
  'kiri.json': machine('kiri', 'Pacific/Kiritimati', kiri, '2026-03-20T08:00:00.000Z'),
  'midway.json': machine(
    'midway',
    'Pacific/Midway',
    randomDays(30, 420, false),
    '2026-04-05T09:00:00.000Z',
  ),
  'old.json': {
    hostname: 'old',
    lastUpdated: '2025-11-01T00:00:00.000Z',
    days: randomDays(10, 400, false),
  },
  'dupe.json': machine('dupe', 'Pacific/Kiritimati', kiri, '2026-03-21T08:00:00.000Z'),
};
for (const [name, value] of Object.entries(files))
  writeFileSync(join(app, 'repo/data', name), JSON.stringify(value, null, 2));
writeFileSync(join(app, 'repo/data/bad.json'), '{"hostname": 5}');

const dump = `
const lib = ${JSON.stringify(lib)};
const usageData = await import(lib + '/data/usageData.ts');
const report = await import(lib + '/data/usageReport.ts');
const top = await import(lib + '/data/topUsage.ts');
const { aggregateProjects } = await import(lib + '/data/projectUsage.ts');
const now = new Date('2026-04-05T10:30:00.000Z');
const FIELDS = ['inputTokens', 'outputTokens', 'rawInputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'cacheCreation1hInputTokens', 'costUSD', 'hasUnpricedTokens'];
const counts = (c) => Object.fromEntries(FIELDS.filter((f) => c[f] !== undefined).map((f) => [f, c[f]]));
const record = (r) => r === undefined ? null : Object.entries(r).map(([k, v]) => [k, counts(v)]);
const days = (map) => [...map].map(([date, day]) => [date, { counts: counts(day), byModel: record(day.byModel), byProject: record(day.byProject), byCwd: record(day.byCwd) }]);
const data = (pd) => Object.entries(pd).map(([k, m]) => [k, days(m)]);
const attempt = (f) => { try { return f(); } catch (error) { return { error: error.message }; } };
const attemptAsync = async (f) => { try { return await f(); } catch (error) { return { error: error.message }; } };

const loaded = await usageData.loadMergedProviderData();
const viewerToday = new Date(now.getTime());
const live = new Map();
for (let i = 0; i < 12; i++) {
  const d = new Date(Date.UTC(2026, 3, 5) - i * 3 * 86400000).toISOString().slice(0, 10);
  const c = { inputTokens: 1000 * (i + 1), outputTokens: 50 * i, cachedInputTokens: 300 * i, ...(i % 3 === 0 ? {} : { costUSD: i * 0.37 }) };
  const unpriced = c.costUSD === undefined ? { hasUnpricedTokens: true } : {};
  live.set(d, { ...c, ...unpriced, byModel: { [i % 2 ? 'composer-2' : 'weird-model']: { ...c, ...unpriced } } });
}
const zoned = usageData.mergeUsageSources(loaded.zonedSources, { cursor: live });
const periods = [
  ['today', {}], ['yesterday', {}], ['date', { from: '2026-03-08' }], ['date', { from: '2026-04-04' }],
  ['range', { from: '2026-03-01', to: '2026-04-05' }], ['thisweek', {}], ['lastweek', {}], ['week', {}], ['thismonth', {}],
  ['lastmonth', {}], ['month', {}], ['last', { n: 3 }], ['last', { n: 400 }], ['year', {}], ['all', {}],
];
const projects = [undefined, { kind: 'project', project: 'o/r' }, { kind: 'project', project: 'b/b' }, { kind: 'dir', dir: '/nonexistent/aitrack' }].slice(0, process.env.TZ === 'Europe/Berlin' ? 4 : 2);
const reports = [];
for (const [period, args] of periods) for (const project of projects) {
  const options = { period, ...args, ...(project && { project }) };
  reports.push({ options, report: attempt(() => report.buildUsageReportFromLoaded(zoned, options, now)), breakdown: attempt(() => report.buildProjectBreakdownsFromLoaded(zoned, [options], now)[0]) });
}
const comparisons = [];
for (const [period, args] of periods.filter(([p]) => ['today', 'range', 'thisweek', 'thismonth', 'lastmonth', 'last', 'year', 'all'].includes(p))) for (const project of projects.slice(0, 2)) {
  const options = { period, ...args, ...(project && { project }) };
  comparisons.push({ options, result: await attemptAsync(() => report.buildUsageComparison(options, now)) });
}
const filters = [undefined, { year: 2026 }, { start: '2026-03-01', end: '2026-04-05' }];
const tops = [];
for (const filter of filters) for (const sort of ['tokens', 'cost']) for (const limit of filter ? [4] : [4, 1000]) {
  const d = top.topDays(zoned.providerData, limit, sort, filter);
  const m = top.topModels(zoned.providerData, limit, sort, filter);
  tops.push({ filter: filter ?? null, sort, limit, days: d, models: m, projects: top.topProjects(zoned.providerData, limit, sort, filter), unpriced: top.unpricedTopModels([...d, ...m]), topProvider: d.map((e) => top.topProviderKey(e.byProvider)) });
}
const reported = await usageData.loadReportedMachines();
console.log(JSON.stringify({
  loaded: { providerData: data(loaded.providerData), sources: loaded.zonedSources.map((s) => ({ hostname: s.hostname, timezone: s.timezone, lastUpdated: s.lastUpdated, current: s.current })), machineData: loaded.machineData.map((m) => m.hostname), warnedNotConfigured: loaded.warnedNotConfigured },
  live: days(live),
  machineTotals: reported.map((m) => ({ hostname: m.hostname, totals: usageData.machineUsageTotals(m) })),
  zones: report.machineZones(loaded.zonedSources),
  aggregate: aggregateProjects(zoned.providerData),
  reports, comparisons, tops,
}));
`;

const pure = `
const lib = ${JSON.stringify(lib)};
const periods = await import(lib + '/data/usagePeriods.ts');
const format = await import(lib + '/display/format.ts');
const { budgetStatus } = await import(lib + '/data/budget.ts');
const { isStaleSync } = await import(lib + '/data/staleSync.ts');
const empty = await import(lib + '/data/emptyState.ts');
const { findDuplicateMachineDays } = await import(lib + '/data/duplicateMachines.ts');
const attempt = (f) => { try { return f(); } catch (error) { return { error: error.message }; } };
const now = new Date('2026-04-05T10:30:00.000Z');
const windows = [];
for (const today of ['2026-04-05', '2024-02-29', '2026-03-31', '2026-01-01', '2025-12-31', '2026-06-14', '2024-03-31']) {
  for (const [period, args] of [['today', {}], ['yesterday', {}], ['date', { from: '2026-02-28' }], ['range', { from: '2026-01-31', to: '2026-03-01' }], ['thisweek', {}], ['lastweek', {}], ['week', {}], ['thismonth', {}], ['lastmonth', {}], ['month', {}], ['last', { n: 1 }], ['last', { n: 45 }], ['year', {}], ['all', {}]]) {
    const options = { period, ...args };
    const current = attempt(() => periods.computeUsageWindow(options, today, now));
    windows.push({ today, options, current, previous: attempt(() => periods.computePreviousUsageWindow(options, undefined, today)) });
  }
}
const parse = [];
for (const [period, args] of [['today', []], ['today', ['x']], ['date', []], ['date', ['2026-02-30']], ['date', ['2026-02-28']], ['date', ['a', 'b']], ['range', ['2026-03-02', '2026-03-01']], ['range', ['x', '2026-01-01']], ['range', ['2026-01-01', 'y']], ['range', ['2026-01-01']], ['range', ['2026-01-01', '2026-01-01']], ['last', ['0']], ['last', ['1e3']], ['last', ['36501']], ['last', ['36500']], ['last', ['007']], ['last', []], ['last', ['99999999999999999999']], ['all', ['x']]]) {
  parse.push({ period, args, result: attempt(() => periods.usagePeriodDefinition(period).parseArgs(args)) });
}
const ints = ['1', '0', '-1', '1.0', '1e3', '0x10', ' 5', '9007199254740991', '9007199254740992', ''].map((v) => [v, periods.parsePositiveInteger(v)]);
const fmt = [0, 5, 999, 1000, 1049, 1050, 1949.99, 99949, 999949, 999950, 999999, 1e6, 1234567, 999949999, 999950000, 1e9, 123456789012, 3.5].map((n) => [n, format.fmt(n)]);
const usd = [null, 0, -1, 0.004, 0.005, 0.01, 1.005, 0.015, 1234567.125, 999.995, 2.5, 1e15, 12345.675, 0.125, 7].map((n) => [n, format.fmtUSD(n), n === null ? null : format.fmtUSDCost(n)]);
const fixed = [];
for (const x of [1.25, 1.35, 1.005, 0.5, 2.5, -1.25, 999.95, 1e-7, 123.456, 0.045, 1.45, 8.345]) for (const d of [0, 1, 2]) fixed.push([x, d, x.toFixed(d)]);
const budget = [[10, 0], [10, -1], [7, 10], [8, 10], [10, 10], [12, 10], [0, 10], [0.7999999, 1]].map(([s, b]) => [s, b, budgetStatus(s, b)]);
const stale = ['2026-04-02T10:30:00.000Z', '2026-04-02T10:29:59.999Z', 'garbage', '', '2026-04-05'].map((t) => [t, isStaleSync(t, now.getTime())]);
const messages = [empty.usageEmptyMessage(true), empty.usageEmptyMessage(false), empty.usageEmptyMessage(false, ['codex', 'cursor', 'zzz']), empty.usageEmptyWindowMessage('last week'), empty.usageEmptyWindowMessage(''), empty.usageEmptyWindowMessage()];
const day = { codex: { byModel: { m: { inputTokens: 1, outputTokens: 1 } }, totals: { inputTokens: 1, outputTokens: 1 } } };
const other = { codex: { byModel: { m: { inputTokens: 2, outputTokens: 1 } }, totals: { inputTokens: 2, outputTokens: 1 } } };
const dupes = findDuplicateMachineDays([
  { hostname: 'b', days: { '2026-01-02': day, '2026-01-01': day } },
  { hostname: 'a', days: { '2026-01-02': day, '2026-01-03': other } },
  { hostname: 'c', days: { '2026-01-01': day, '2026-01-03': day } },
]);
console.log(JSON.stringify({ windows, parse, ints, fmt, usd, fixed, budget, stale, messages, dupes }));
`;

const work = mkdtempSync(join(tmpdir(), 'aitrack-reports-golden-'));
writeFileSync(join(work, 'dump.mts'), dump);
writeFileSync(join(work, 'pure.mts'), pure);
const run = (script: string, zone: string, home: string) =>
  JSON.parse(
    execFileSync(process.execPath, ['--import', 'tsx', join(work, script)], {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH,
        TZ: zone,
        HOME: home,
        USERPROFILE: home,
        AITRACK_NO_CACHE: '1',
        AITRACK_NO_PRICING_REFRESH: '1',
        CURSOR_STATE_DB_PATH: '/nonexistent/state.vscdb',
        CURSOR_CONFIG_DIR: '/nonexistent',
        AITRACK_CLAUDE_PROJECTS_DIRS: join(corpus, 'claude'),
        AITRACK_CODEX_SESSION_DIRS: join(corpus, 'codex'),
      },
    }).toString(),
  );
const expected: Record<string, unknown> = { pure: run('pure.mts', 'Europe/Berlin', work) };
for (const zone of ['Europe/Berlin', 'Pacific/Kiritimati', 'Pacific/Midway']) {
  const home = join(work, zone.replace('/', '-'));
  cpSync(fixtureHome, home, { recursive: true });
  mkdirSync(join(home, '.config/aitrack/repo/.git'), { recursive: true });
  expected[zone] = run('dump.mts', zone, home);
}
writeFileSync(join(here, 'expected.json'), `${JSON.stringify(expected)}\n`);
rmSync(work, { recursive: true, force: true });
