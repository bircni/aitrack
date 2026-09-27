import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { buildUsageReport } from 'aitrack-lib/data/usageReport';
import { readClaudeData } from 'aitrack-lib/readers/claude';
import { parseCodexFile } from 'aitrack-lib/readers/codex';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_HOME = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return mkdtempSync(joinPath(tmpdir(), 'aitrack-desktop-ingest-'));
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { localDay } from '../budget.js';
import { INGEST_VERSION, churnIsCurrent, commitWindow, ingestAll } from '../ingest.js';
import { DesktopStore } from '../store.js';
import { connectDataRepo, previewPush } from '../sync.js';

const previousEnv = {
  HOME: process.env.HOME,
  AITRACK_CLAUDE_PROJECTS_DIRS: process.env.AITRACK_CLAUDE_PROJECTS_DIRS,
  AITRACK_CODEX_SESSION_DIRS: process.env.AITRACK_CODEX_SESSION_DIRS,
};

describe('ingestAll', () => {
  const projects = join(TEST_HOME, 'claude-projects');
  const repo = join(TEST_HOME, 'repo');
  let store: DesktopStore;

  beforeAll(() => {
    process.env.HOME = TEST_HOME;
    process.env.AITRACK_CLAUDE_PROJECTS_DIRS = projects;
    process.env.AITRACK_CODEX_SESSION_DIRS = join(TEST_HOME, 'codex');
    mkdirSync(join(projects, 'demo'), { recursive: true });
    const codexDir = join(TEST_HOME, 'codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, 'rollout.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-09-20T12:00:00.000Z',
        payload: { session_id: 'codex-1', cwd: repo },
      })}\n${JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-09-20T12:00:00.000Z',
        payload: { model: 'gpt-4o' },
      })}\n${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-09-20T12:01:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 80, output_tokens: 20, cached_input_tokens: 10 },
          },
        },
      })}\n`,
    );
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const value = 1;\n');
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_AUTHOR_DATE: '2026-09-20T12:05:00Z',
      GIT_COMMITTER_DATE: '2026-09-20T12:05:00Z',
    };
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['add', 'src/app.ts'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['commit', '-m', 'add app'], { cwd: repo, env: gitEnv });
    const file = join(repo, 'src', 'app.ts');
    writeFileSync(
      join(projects, 'demo', 'sess.jsonl'),
      `${JSON.stringify({
        type: 'user',
        timestamp: '2026-09-20T12:00:00.000Z',
        sessionId: 'sess',
        cwd: repo,
        gitBranch: 'main',
        message: { role: 'user', content: 'please edit the app' },
      })}\n${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-20T12:04:00.000Z',
        sessionId: 'sess',
        requestId: 'r1',
        message: {
          id: 'msg1',
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }],
        },
      })}\n`,
    );
    store = DesktopStore.open(join(TEST_HOME, 'desktop.sqlite'));
  });

  afterAll(() => {
    store.close();
    if (previousEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previousEnv.HOME;
    if (previousEnv.AITRACK_CLAUDE_PROJECTS_DIRS === undefined)
      delete process.env.AITRACK_CLAUDE_PROJECTS_DIRS;
    else process.env.AITRACK_CLAUDE_PROJECTS_DIRS = previousEnv.AITRACK_CLAUDE_PROJECTS_DIRS;
    if (previousEnv.AITRACK_CODEX_SESSION_DIRS === undefined)
      delete process.env.AITRACK_CODEX_SESSION_DIRS;
    else process.env.AITRACK_CODEX_SESSION_DIRS = previousEnv.AITRACK_CODEX_SESSION_DIRS;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('links the fixture session to the commit and matches Claude usage totals', async () => {
    const summary = await ingestAll(store, { cursor: false });
    expect(summary.sessions).toBe(2);
    expect(summary.links).toBeGreaterThan(0);
    const session = store.getSession('claude:sess');
    expect(session?.title).toBe('app.ts');
    expect(session?.links[0]?.subject).toBe('add app');
    expect(session?.links[0]?.explanation).toMatch(/files|Committed/u);

    const claude = await readClaudeData();
    let cost = 0;
    for (const day of claude.values()) cost += day.costUSD ?? 0;
    const storedDays = store.usageDays().filter((day) => day.provider === 'claude_code');
    const stored = storedDays.reduce((sum, day) => sum + day.costUsd, 0);
    expect(stored).toBeCloseTo(cost, 6);
    const report = await buildUsageReport({
      period: 'all',
      providers: ['claude_code'],
      refreshLive: false,
    });
    expect(report).not.toBeNull();
    if (report === null) return;
    const sum = (pick: (day: (typeof storedDays)[number]) => number): number =>
      storedDays.reduce((total, day) => total + pick(day), 0);
    expect(sum((day) => day.inputTokens)).toBe(report.totals.inputTokens);
    expect(sum((day) => day.outputTokens)).toBe(report.totals.outputTokens);
    expect(sum((day) => day.cachedTokens)).toBe(report.totals.cachedInputTokens);
    expect(sum((day) => day.costUsd)).toBeCloseTo(report.totals.costUSD, 6);
    const codex = await parseCodexFile(join(TEST_HOME, 'codex', 'rollout.jsonl'));
    let codexInput = 0;
    let codexOutput = 0;
    let codexCost = 0;
    for (const day of codex.days.values()) {
      codexInput += day.inputTokens;
      codexOutput += day.outputTokens;
      codexCost += day.costUSD ?? 0;
    }
    const storedCodex = store.usageDays().filter((day) => day.provider === 'codex');
    expect(storedCodex.reduce((total, day) => total + day.inputTokens, 0)).toBe(codexInput);
    expect(storedCodex.reduce((total, day) => total + day.outputTokens, 0)).toBe(codexOutput);
    expect(storedCodex.reduce((total, day) => total + day.costUsd, 0)).toBeCloseTo(codexCost, 6);
    const metrics = store.dailyMetrics(localDay(new Date()));
    expect(metrics.some((row) => row.metric === 'lead-time' && row.inputs.includes('Median'))).toBe(
      true,
    );
  });

  it('opens history at the first session, then keeps one day of overlap', () => {
    const first = commitWindow({
      full: false,
      latestCommit: null,
      earliestSession: '2026-09-20T12:00:00.000Z',
      now: Date.parse('2026-09-27T00:00:00.000Z'),
    });
    expect(first).toBe('2026-09-13T12:00:00.000Z');
    const next = commitWindow({
      full: false,
      latestCommit: '2026-09-20T12:05:00.000Z',
      earliestSession: '2026-09-20T12:00:00.000Z',
    });
    expect(next).toBe('2026-09-19T12:05:00.000Z');
    const rebuilt = commitWindow({
      full: true,
      latestCommit: '2026-09-20T12:05:00.000Z',
      earliestSession: '2026-09-20T12:00:00.000Z',
    });
    expect(rebuilt).toBe('2026-09-13T12:00:00.000Z');
  });

  it('re-reads transcripts after the desktop version changes', async () => {
    const file = join(projects, 'demo', 'sess.jsonl');
    const info = await stat(file);
    expect(store.sourceFresh(file, info.size, info.mtimeMs)).toBe(true);
    store.setSetting('ingestVersion', '0.0.0');
    const again = await ingestAll(store, { cursor: false });
    expect(again.sessions).toBe(2);
    expect(store.setting<string>('ingestVersion', '')).toBe(INGEST_VERSION);
    expect(store.getSession('claude:sess')?.links[0]?.subject).toBe('add app');
  });

  it('refuses to clone a data repo without confirmation', () => {
    const result = connectDataRepo('nope', 'git@example.com:me/data.git');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not confirmed/u);
  });

  it('describes a push without writing when no data repo is configured', async () => {
    const preview = await previewPush();
    expect(preview.ok).toBe(false);
    expect(preview.file).toBeNull();
    expect(preview.days).toBe(0);
  });

  it('leaves transcripts unread when every provider is off', async () => {
    const quiet = DesktopStore.open(join(TEST_HOME, 'quiet.sqlite'));
    const summary = await ingestAll(quiet, { claude: false, codex: false, cursor: false });
    expect(summary.sessions).toBe(0);
    expect(quiet.listSessions()).toEqual([]);
    quiet.close();
  });
});

describe('churnIsCurrent', () => {
  const measured = { churn7: 0.2, churnNote: 'kept', churnHead: 'abc' };

  it('keeps a result measured at the current HEAD', () => {
    expect(churnIsCurrent(measured, 'abc')).toBe(true);
  });

  it('measures again when HEAD moves or nothing has been stored', () => {
    expect(churnIsCurrent(measured, 'def')).toBe(false);
    expect(churnIsCurrent({ churn7: null, churnNote: null, churnHead: null }, 'abc')).toBe(false);
    expect(
      churnIsCurrent(
        { churn7: null, churnNote: 'src/app.ts is over 1 MB', churnHead: 'abc' },
        'abc',
      ),
    ).toBe(true);
  });
});
