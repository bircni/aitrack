// Regenerate with `node --import tsx crates/core/tests/fixtures/readers/generate.ts` while the 4.x library is in the tree.
// Writes a small log corpus, then records what the 4.x readers make of it in several time zones.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = join(here, 'corpus');
const repoRoot = join(here, '../../../../..');

let seed = 0x1234abcd;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const line = (value: unknown) => JSON.stringify(value);

function write(path: string, lines: string[], ending = '\n'): void {
  mkdirSync(dirname(join(corpus, path)), { recursive: true });
  writeFileSync(join(corpus, path), lines.join(ending) + ending);
}

function copy(fixture: string, path: string): void {
  mkdirSync(dirname(join(corpus, path)), { recursive: true });
  copyFileSync(join(repoRoot, 'libs/test-fixtures/src/providers', fixture), join(corpus, path));
}

const usage = (input: number, output: number, extra: Record<string, unknown> = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  ...extra,
});
const assistant = (
  timestamp: string,
  id: string | undefined,
  requestId: string | undefined,
  model: unknown,
  u: unknown,
) =>
  line({
    type: 'assistant',
    timestamp,
    ...(requestId && { requestId }),
    message: { ...(id && { id }), model, usage: u, content: [{ type: 'text', text: 'x' }] },
  });

rmSync(corpus, { recursive: true, force: true });

// Claude: two sessions sharing message keys (first file wins), a resumed copy, and every malformed shape.
write('claude/proj-a/a-session.jsonl', [
  line({ type: 'user', cwd: '/nonexistent/aitrack/repo-a', timestamp: '2026-03-07T23:30:00Z' }),
  assistant(
    '2026-03-07T23:30:05Z',
    'm1',
    'r1',
    'claude-sonnet-4-5-20250929',
    usage(100, 1, { cache_creation_input_tokens: 50 }),
  ),
  assistant(
    '2026-03-07T23:30:09Z',
    'm1',
    'r1',
    'claude-sonnet-4-5-20250929',
    usage(100, 40, { cache_creation_input_tokens: 50 }),
  ),
  assistant(
    '2026-03-07T23:30:10Z',
    'm1',
    'r1',
    'claude-sonnet-4-5-20250929',
    usage(100, 40, { cache_creation_input_tokens: 60 }),
  ),
  line({ type: 'system', cwd: '/nonexistent/aitrack/repo-b', timestamp: '2026-03-08T00:10:00Z' }),
  assistant(
    '2026-03-08T00:10:05Z',
    'm2',
    'r2',
    'claude-opus-4-1-latest',
    usage(10, 5, {
      cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 },
    }),
  ),
  assistant('2026-03-08T10:00:00Z', 'm3', 'r3', 'claude-haiku-5-5', usage(100_001, 5)),
  assistant('2026-03-08T10:00:01Z', 'm4', 'r4', 'claude-opus-4-1', {
    ...usage(1, 1),
    speed: 'fast',
  }),
  line({ type: 'user', cwd: 'constructor', timestamp: '2026-03-08T11:00:00Z' }),
  assistant(
    '2026-03-08T11:00:05Z',
    'm5',
    'r5',
    'claude-haiku-5-5',
    usage(99_000, 5, { cache_read_input_tokens: 2000 }),
  ),
  assistant('2026-03-08T11:10:00Z', 'tie', 'r9', 'claude-opus-4-1', usage(20, 20)),
  assistant('2026-03-08T11:10:01Z', 'tie', 'r9', 'claude-sonnet-4-5', usage(20, 20)),
]);
write('claude/proj-a/b-resumed.jsonl', [
  line({ type: 'user', cwd: '/nonexistent/aitrack/repo-c', timestamp: '2026-03-08T12:00:00Z' }),
  assistant('2026-03-08T12:00:01Z', 'm2', 'r2', 'claude-opus-4-1', usage(999, 999)),
  assistant('2026-03-08T12:00:02Z', 'm6', 'r6', 'claude-opus-4-1', usage(3, 4)),
  assistant('2026-03-08T12:00:03Z', 'm1', 'r1', 'claude-opus-4-1', usage(1, 1)),
  assistant('2026-03-08T12:00:04Z', 'm7', 'r7', 'claude-opus-4-1', usage(5, 6)),
]);
write('claude/proj-a/c-all-new.jsonl', [
  assistant('2026-03-09T01:00:00Z', 'm8', 'r8', 'claude-opus-4-1', usage(8, 8)),
]);
write(
  'claude/proj-b/nested/edge-cases.jsonl',
  [
    assistant('2026-03-08T05:00:00Z', undefined, undefined, 'claude-opus-4-1', usage(1, 2)),
    assistant('2026-03-08T05:00:00Z', undefined, undefined, 'claude-opus-4-1', usage(1, 2)),
    line({
      type: 'assistant',
      timestamp: '2026-03-08T05:00:01Z',
      requestId: 7,
      message: { id: 12.0, model: 'm', usage: usage(1, 1) },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-03-08T05:00:01Z',
      message: { id: [1, null, 'x'], usage: usage(2, 2) },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-03-08T05:00:01Z',
      message: { id: { a: 1 }, model: null, usage: usage(3, 3) },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-03-08T05:00:02Z',
      message: 'not an object',
      usage: usage(9, 9),
    }),
    line({
      type: 'assistant',
      timestamp: '2026-03-08T05:00:02Z',
      message: { id: 'u1', usage: [1, 2] },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-03-08T05:00:02Z',
      message: { id: 'u2', usage: 'text' },
    }),
    assistant('2026-03-08T05:00:03Z', 'n1', 'q', 'claude-opus-4-1', usage(-1, 2)),
    assistant('2026-03-08T05:00:03Z', 'n2', 'q', 'claude-opus-4-1', usage(1.5, 2)),
    assistant('2026-03-08T05:00:03Z', 'n3', 'q', 'claude-opus-4-1', usage(2 ** 40 + 1, 2)),
    assistant('2026-03-08T05:00:03Z', 'n4', 'q', 'claude-opus-4-1', usage(5.0, 2)),
    assistant('2026-03-08T05:00:03Z', 'n5', 'q', 'claude-opus-4-1', {
      input_tokens: null,
      output_tokens: 3,
      cache_read_input_tokens: null,
    }),
    assistant('2026-03-08T05:00:03Z', 'n6', 'q', 'claude-opus-4-1', {
      input_tokens: '4',
      output_tokens: 3,
    }),
    assistant('2026-03-08T05:00:03Z', 'n7', 'q', 'claude-opus-4-1', usage(0, 0)),
    assistant('2026-03-08T05:00:03Z', 'n8', 'q', 'claude-opus-4-1', {
      input_tokens: 1,
      cache_creation: 'x',
      cache_creation_input_tokens: 9,
    }),
    assistant('2026-03-08T05:00:03Z', 'n9', 'q', 'claude-opus-4-1', {
      input_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: -1 },
    }),
    line({
      type: 'user',
      timestamp: '2026-03-08T05:00:04Z',
      message: { id: 'not-assistant', usage: usage(5, 5) },
    }),
    assistant('garbage', 't1', 'q', 'claude-opus-4-1', usage(1, 1)),
    assistant('2026-03-08', 't2', 'q', 'claude-opus-4-1', usage(1, 1)),
    assistant('2026-03-08T23:59:00', 't3', 'q', 'claude-opus-4-1', usage(1, 1)),
    assistant('2026-03-08 23:59:00', 't4', 'q', 'claude-opus-4-1', usage(1, 1)),
    assistant('2026-02-30T10:00:00Z', 't5', 'q', 'claude-opus-4-1', usage(1, 1)),
    assistant('0999-12-31T23:00:00Z', 't6', 'q', 'claude-opus-4-1', usage(1, 1)),
    line({
      type: 'assistant',
      timestamp: 1772964000000,
      message: { id: 't7', usage: usage(1, 1) },
    }),
    assistant('2026-03-08T05:00:05Z', 'x1', 'q', '-latest', usage(1, 1)),
    assistant('2026-03-08T05:00:05Z', 'x2', 'q', 'toString', usage(1, 1)),
    assistant('2026-03-08T05:00:05Z', 'x3', 'q', 42, usage(1, 1)),
    '',
    '   ',
    '"usage"',
    '[{"usage":1}]',
    '{"type":"assistant","timestamp":"2026-03-08T05:00:06Z","message":{"id":"bad-utf8","usage":{"input_tokens":1,"output_tokens":1},"text":"\xff"}}',
    '{"type":"assistant","timestamp":"2026-03-08T05:00:07Z","message":{"id":"truncated","usage":{"input_tokens":1',
  ],
  '\r\n',
);
// A raw 0xFF byte, which no JS string literal can write; Node reads it as U+FFFD.
const edgeCases = join(corpus, 'claude/proj-b/nested/edge-cases.jsonl');
writeFileSync(
  edgeCases,
  Buffer.from(
    readFileSync(edgeCases).toString('latin1').replace('\u00c3\u00bf', '\u00ff'),
    'latin1',
  ),
);
for (let file = 0; file < 4; file++) {
  const lines: string[] = [];
  let cwdIndex = 0;
  for (let i = 0; i < 300; i++) {
    const day = 1 + Math.floor(random() * 5);
    const hour = Math.floor(random() * 24);
    const ts = `2026-04-0${day}T${String(hour).padStart(2, '0')}:${String(Math.floor(random() * 60)).padStart(2, '0')}:00${pick(['Z', 'Z', '+05:30', '-11:00', '.123Z'])}`;
    const roll = random();
    if (roll < 0.15)
      lines.push(
        line({
          type: pick(['user', 'system']),
          cwd: `/nonexistent/aitrack/r${(cwdIndex = (cwdIndex + 1) % 4)}`,
          timestamp: ts,
        }),
      );
    else if (roll < 0.2)
      lines.push(
        line({ type: 'progress', timestamp: ts, data: 'x'.repeat(Math.floor(random() * 200)) }),
      );
    else {
      const id = `rand-${Math.floor(random() * 120)}`;
      const u: Record<string, unknown> = usage(
        Math.floor(random() * 5000),
        Math.floor(random() * 800),
        {
          cache_read_input_tokens: Math.floor(random() * 30_000),
        },
      );
      if (random() < 0.3)
        u.cache_creation = {
          ephemeral_5m_input_tokens: Math.floor(random() * 900),
          ephemeral_1h_input_tokens: Math.floor(random() * 300),
        };
      else if (random() < 0.5) u.cache_creation_input_tokens = Math.floor(random() * 900);
      if (random() < 0.05) u.speed = 'fast';
      const keyed = random() < 0.9;
      lines.push(
        assistant(
          ts,
          keyed ? id : undefined,
          keyed ? `req-${id}` : undefined,
          pick([
            'claude-opus-4-1',
            'claude-sonnet-4-5-20250929',
            'claude-haiku-5-5',
            'claude-3.5-haiku-latest',
          ]),
          u,
        ),
      );
    }
  }
  write(`claude/random/r${file}.jsonl`, lines);
}
copy('claude-session.jsonl', 'claude/fixture/claude-session.jsonl');

// Codex: cumulative totals with a compaction, last-only events, model switches and malformed records.
const meta = (ts: string, payload: Record<string, unknown>) =>
  line({ timestamp: ts, type: 'session_meta', payload });
const turn = (ts: string, payload: Record<string, unknown>) =>
  line({ timestamp: ts, type: 'turn_context', payload });
const count = (ts: string, info: unknown) =>
  line({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info } });
const tokens = (input: number, output: number, cached?: number) => ({
  input_tokens: input,
  output_tokens: output,
  ...(cached !== undefined && { cached_input_tokens: cached }),
});
write('codex/2026/03/08/rollout-git.jsonl', [
  meta('2026-03-07T23:00:00Z', {
    cwd: '/nonexistent/aitrack/codex-a',
    git: { repository_url: 'git@github.com:Owner/Repo.git' },
  }),
  turn('2026-03-07T23:00:01Z', { model: 'gpt-5', cwd: '/nonexistent/aitrack/ignored' }),
  count('2026-03-07T23:30:00Z', {
    total_token_usage: tokens(1000, 100, 400),
    last_token_usage: tokens(1000, 100, 400),
  }),
  line({ timestamp: '2026-03-08T00:30:00Z', type: 'response_item', payload: { type: 'message' } }),
  count('2026-03-08T00:31:00Z', {
    total_token_usage: tokens(1800, 250),
    last_token_usage: tokens(800, 150),
  }),
  turn('2026-03-08T01:00:00Z', { model: 'gpt-5-codex-latest' }),
  count('2026-03-08T01:00:05Z', { total_token_usage: tokens(2000, 300, 500) }),
  count('2026-03-08T01:00:06Z', {
    total_token_usage: tokens(500, 50, 100),
    last_token_usage: tokens(400, 40, 90),
  }),
  count('2026-03-08T01:00:07Z', { total_token_usage: tokens(400, 40, 90) }),
  count('2026-03-08T01:00:08Z', { last_token_usage: tokens(7, 3) }),
  count('2026-03-08T01:00:09Z', null),
  count('2026-03-08T01:00:10Z', { total_token_usage: { input_tokens: -5 } }),
  count('2026-03-08T01:00:11Z', { total_token_usage: tokens(600, 60, 50) }),
  count('2026-03-08T01:00:12Z', { total_token_usage: 0, last_token_usage: tokens(1, 1) }),
  count('2026-03-08T01:00:13Z', { total_token_usage: [1], last_token_usage: tokens(1, 1) }),
  count('2026-03-08T01:00:14Z', [1, 2]),
  line({ timestamp: '2026-03-08T01:00:15Z', type: 'event_msg', payload: 'token_count' }),
  line({
    timestamp: '2026-03-09T09:00:00Z',
    type: 'event_msg',
    payload: { type: 'agent_message' },
  }),
  count('garbage', { total_token_usage: tokens(700, 70, 60) }),
]);
write('codex/2026/03/08/rollout-cwd.jsonl', [
  meta('2026-03-08T10:00:00Z', { cwd: 42 }),
  turn('2026-03-08T10:00:01Z', { model: 'gpt-5-mini', cwd: '/nonexistent/aitrack/codex-b' }),
  turn('2026-03-08T10:00:02Z', { model: 'gpt-5', cwd: '/nonexistent/aitrack/codex-c' }),
  count('2026-03-08T10:00:03Z', { total_token_usage: tokens(10, 2) }),
  meta('2026-03-08T10:00:04Z', { git: { repository_url: 'not a url' } }),
]);
write('codex/2026/03/08/rollout-empty.jsonl', [
  meta('2026-03-08T10:00:00Z', { cwd: '/nonexistent/aitrack/codex-d' }),
]);
write('codex/2026/03/09/rollout-no-date.jsonl', [
  turn('bad', { model: 'gpt-5' }),
  count('bad', { total_token_usage: tokens(10, 2) }),
  line({ timestamp: '2026-03-09T08:00:00Z', type: 'response_item', payload: {} }),
  count('bad', { total_token_usage: tokens(30, 4) }),
]);
for (let file = 0; file < 3; file++) {
  const lines = [
    meta(
      '2026-04-01T00:00:00Z',
      random() < 0.5
        ? { cwd: `/nonexistent/aitrack/cr${file}` }
        : { git: { repository_url: `https://github.com/o/r${file}` } },
    ),
  ];
  let input = 0;
  let output = 0;
  let cached = 0;
  for (let i = 0; i < 150; i++) {
    const ts = `2026-04-0${1 + Math.floor(i / 40)}T${String(Math.floor(random() * 24)).padStart(2, '0')}:00:00Z`;
    const roll = random();
    if (roll < 0.1)
      lines.push(turn(ts, { model: pick(['gpt-5', 'gpt-5-codex', 'gpt-5.1-codex-max']) }));
    else if (roll < 0.2)
      lines.push(line({ timestamp: ts, type: 'response_item', payload: { type: 'reasoning' } }));
    else if (roll < 0.25) {
      input = Math.floor(input / 3);
      output = Math.floor(output / 3);
      lines.push(
        count(ts, {
          total_token_usage: tokens(input, output, cached),
          last_token_usage: tokens(100, 10, 5),
        }),
      );
    } else {
      input += Math.floor(random() * 3000);
      output += Math.floor(random() * 300);
      cached += Math.floor(random() * 1000);
      lines.push(
        count(ts, {
          total_token_usage: tokens(input, output, random() < 0.2 ? undefined : cached),
        }),
      );
    }
  }
  write(`codex/random/c${file}.jsonl`, lines);
}
copy('codex-session.jsonl', 'codex/fixture/codex-session.jsonl');

// What 4.x makes of the corpus, per zone. Costs are left out until the pricing port.
const dump = `
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
const { scanClaudeFile } = await import(${JSON.stringify(join(repoRoot, 'libs/aitrack-lib/src/readers/claudeScan.ts'))});
const { scanCodexFile } = await import(${JSON.stringify(join(repoRoot, 'libs/aitrack-lib/src/readers/codexScan.ts'))});
const { readClaudeData } = await import(${JSON.stringify(join(repoRoot, 'libs/aitrack-lib/src/readers/claude.ts'))});
const { readCodexData } = await import(${JSON.stringify(join(repoRoot, 'libs/aitrack-lib/src/readers/codex.ts'))});
const { listUniqueSourceFiles } = await import(${JSON.stringify(join(repoRoot, 'libs/aitrack-lib/src/readers/paths.ts'))});
const FIELDS = ['inputTokens', 'outputTokens', 'rawInputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'cacheCreation1hInputTokens'];
const counts = (c) => Object.fromEntries(FIELDS.filter((f) => c[f] !== undefined).map((f) => [f, c[f]]));
const record = (r) => r === undefined ? null : Object.entries(r).map(([k, v]) => [k, counts(v)]);
const days = (map) => [...map].map(([date, day]) => [date, { counts: counts(day), byModel: record(day.byModel), byProject: record(day.byProject), byCwd: record(day.byCwd) }]);
const corpus = ${JSON.stringify(corpus)};
const rel = (file) => relative(corpus, file).split('\\\\').join('/');
const claudeFiles = await listUniqueSourceFiles([join(corpus, 'claude')]);
const codexFiles = await listUniqueSourceFiles([join(corpus, 'codex')]);
const out = {
  claudeFiles: claudeFiles.map(rel),
  codexFiles: codexFiles.map(rel),
  claudeScans: await Promise.all(claudeFiles.map(async (f) => [rel(f), (await scanClaudeFile(f)).map((m) => ({ key: m.key ?? null, date: m.date, model: m.model, counts: counts(m.counts), cwd: m.cwd ?? null }))])),
  codexScans: await Promise.all(codexFiles.map(async (f) => { const s = await scanCodexFile(f); return [rel(f), { sessions: s.sessions, repositoryUrl: s.repositoryUrl ?? null, cwd: s.cwd ?? null }]; })),
  claudeDays: days(await readClaudeData()),
  codexDays: days(await readCodexData()),
};
console.log(JSON.stringify(out));
`;
const home = mkdtempSync(join(tmpdir(), 'aitrack-golden-'));
const script = join(home, 'dump.mts');
writeFileSync(script, dump);
mkdirSync(join(here, 'expected'), { recursive: true });
for (const zone of ['Pacific/Kiritimati', 'UTC', 'Pacific/Midway', 'Europe/Berlin']) {
  const output = execFileSync(process.execPath, ['--import', 'tsx', script], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      TZ: zone,
      HOME: home,
      USERPROFILE: home,
      AITRACK_NO_CACHE: '1',
      AITRACK_NO_PRICING_REFRESH: '1',
      AITRACK_CLAUDE_PROJECTS_DIRS: join(corpus, 'claude'),
      AITRACK_CODEX_SESSION_DIRS: join(corpus, 'codex'),
    },
  }).toString();
  const parsed = JSON.parse(output);
  writeFileSync(
    join(here, 'expected', `${zone.replace('/', '-')}.json`),
    `${JSON.stringify(parsed)}\n`,
  );
}
rmSync(home, { recursive: true, force: true });
