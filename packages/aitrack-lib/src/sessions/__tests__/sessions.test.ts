import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  EXTREME_TIME_ZONES,
  localTimestamp,
  useTimeZone,
  writeJsonl,
} from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseJsonlFile } from '../../readers/claude.js';
import { parseCodexFile, parseSessionFile } from '../../readers/codex.js';
import { LINK_WEIGHTS, linkSession, normalizePath } from '../link/linker.js';
import {
  buildLeverageReport,
  commitsPerLocalDay,
  cursorAcceptance,
  median,
} from '../metrics/compute.js';
import { readClaudeSessionFile } from '../readers/claude.js';
import { readCodexSessionFile } from '../readers/codex.js';
import { readCursorSessionFile } from '../readers/cursor.js';
import { readComposerBounds, readCursorTracking } from '../readers/cursorState.js';
import { resolveEncodedPath } from '../slug.js';
import { isTestPath } from '../testPaths.js';
import { parseTimestamp, pathsInCommand } from '../text.js';
import type { LinkableCommit, Session } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sessions-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveEncodedPath', () => {
  it('resolves a Claude slug when exactly one path exists', () => {
    const tree = new Set(['/Users', '/Users/me', '/Users/me/my-app']);
    const resolved = resolveEncodedPath('-Users-me-my-app', (path) => tree.has(path));
    expect(resolved).toEqual({
      path: '/Users/me/my-app',
      uncertain: false,
      candidates: ['/Users/me/my-app'],
    });
  });

  it('refuses a slug that matches two real trees', () => {
    const tree = new Set(['/Users', '/Users/foo', '/Users/foo/bar', '/Users/foo-bar']);
    const resolved = resolveEncodedPath('Users-foo-bar', (path) => tree.has(path));
    expect(resolved.path).toBeNull();
    expect(resolved.uncertain).toBe(true);
    expect(resolved.candidates).toHaveLength(2);
  });

  it('marks an unknown slug uncertain', () => {
    expect(resolveEncodedPath('missing', () => false).uncertain).toBe(true);
  });
});

describe('isTestPath', () => {
  it('recognises the built-in layouts and an extra glob', () => {
    expect(isTestPath('src/__tests__/a.test.ts')).toBe(true);
    expect(isTestPath('pkg/tests/a.py')).toBe(true);
    expect(isTestPath('e2e/flow.spec.ts')).toBe(true);
    expect(isTestPath('widget_test.go')).toBe(true);
    expect(isTestPath('test_widget.py')).toBe(true);
    expect(isTestPath('MapTests.swift')).toBe(true);
    expect(isTestPath('src/app.ts')).toBe(false);
    expect(isTestPath('fixtures/sample.snap', ['fixtures/**'])).toBe(true);
  });
});

describe('pathsInCommand', () => {
  it('treats redirects as edits and mentions as reads', () => {
    const found = pathsInCommand(
      "cat src/old.ts && cat > src/app.ts <<'EOF'\n*** Update File: docs/a.md",
    );
    expect(found).toContainEqual({ path: 'src/app.ts', kind: 'edit' });
    expect(found).toContainEqual({ path: 'docs/a.md', kind: 'edit' });
    expect(found).toContainEqual({ path: 'src/old.ts', kind: 'read' });
  });
});

describe('parseTimestamp', () => {
  it('keeps a canonical UTC timestamp and normalizes one that is not', () => {
    expect(parseTimestamp('2024-01-15T12:00:00.000Z')).toBe('2024-01-15T12:00:00.000Z');
    expect(parseTimestamp('2024-01-15T12:00:00Z')).toBe('2024-01-15T12:00:00.000Z');
    expect(parseTimestamp('2024-02-31T00:00:00.000Z')).toBe('2024-03-02T00:00:00.000Z');
    expect(parseTimestamp('not a date')).toBeNull();
    expect(parseTimestamp('   ')).toBeNull();
  });
});

describe('readClaudeSessionFile', () => {
  it('matches the day-map token total and keeps files, branch and cwd', async () => {
    const file = join(tmpDir, 'sess.jsonl');
    const at = localTimestamp('2024-01-15');
    writeJsonl(file, [
      {
        type: 'user',
        timestamp: at,
        sessionId: 'sess',
        cwd: '/repo',
        gitBranch: 'main',
        message: { role: 'user', content: 'please edit the app' },
      },
      {
        type: 'assistant',
        timestamp: at,
        sessionId: 'sess',
        requestId: 'r1',
        message: {
          id: 'msg1',
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts' } }],
        },
      },
      {
        type: 'assistant',
        timestamp: at,
        sessionId: 'sess',
        requestId: 'r1',
        message: {
          id: 'msg1',
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 80, output_tokens: 10 },
        },
      },
    ]);

    const dayMap = await parseJsonlFile(file, new Set());
    const { session, signals, dedupeKeys, usage } = await readClaudeSessionFile(file);
    expect(session.inputTokens).toBe(dayMap.get('2024-01-15')?.inputTokens);
    expect(usage?.keys).toEqual(['msg1:r1']);
    expect(Object.fromEntries(usage?.days ?? [])).toEqual(Object.fromEntries(dayMap));
    expect(session.outputTokens).toBe(dayMap.get('2024-01-15')?.outputTokens);
    expect(session.costUSD).toBeCloseTo(dayMap.get('2024-01-15')?.costUSD ?? 0);
    expect(session.cwd).toBe('/repo');
    expect(session.branch).toBe('main');
    expect(session.fileTouches).toEqual([
      expect.objectContaining({ path: 'src/app.ts', kind: 'edit' }),
    ]);
    expect(session.title).toBe('app.ts');
    expect(dedupeKeys).toEqual(['msg1:r1']);
    expect(signals.userExcerpt).toContain('please edit');
    expect(session.userMessages).toBe(1);
  });

  it('keeps one turn when a later line has the fuller usage for the same message', async () => {
    const file = join(tmpDir, 'claude-richer.jsonl');
    const at = '2024-01-15T12:00:00.000Z';
    writeJsonl(file, [
      {
        type: 'assistant',
        timestamp: at,
        sessionId: 'sess',
        requestId: 'r1',
        message: {
          id: 'msg1',
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      {
        type: 'assistant',
        timestamp: at,
        sessionId: 'sess',
        requestId: 'r1',
        message: {
          id: 'msg1',
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 100, output_tokens: 40 },
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts' } }],
        },
      },
    ]);
    const { session, dedupeKeys } = await readClaudeSessionFile(file);
    expect(dedupeKeys).toEqual(['msg1:r1']);
    expect(session.assistantMessages).toBe(1);
    expect(session.outputTokens).toBe(40);
    expect(session.fileTouches).toEqual([
      expect.objectContaining({ path: 'src/app.ts', kind: 'edit' }),
    ]);
  });

  it('keeps the later text when a repeat has the same token counts', async () => {
    const file = join(tmpDir, 'claude-same.jsonl');
    const at = '2024-01-15T12:00:00.000Z';
    const message = {
      id: 'msg1',
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 10, output_tokens: 4 },
    };
    writeJsonl(file, [
      {
        type: 'assistant',
        timestamp: at,
        sessionId: 'sess',
        requestId: 'r1',
        message: { ...message, content: 'first' },
      },
      {
        type: 'assistant',
        timestamp: at,
        sessionId: 'sess',
        requestId: 'r1',
        message: { ...message, content: 'second' },
      },
    ]);
    const { session, signals } = await readClaudeSessionFile(file);
    expect(session.assistantMessages).toBe(1);
    expect(signals.assistantExcerpt).toBe('second');
  });
});

describe('readCodexSessionFile', () => {
  it('matches the day-map token total and records a written path', async () => {
    const file = join(tmpDir, 'rollout.jsonl');
    writeJsonl(file, [
      {
        type: 'session_meta',
        timestamp: localTimestamp('2024-01-15'),
        payload: { session_id: 'codex-1', cwd: '/work', runtime_workspace_roots: ['/work'] },
      },
      {
        type: 'turn_context',
        timestamp: localTimestamp('2024-01-15'),
        payload: { model: 'gpt-4o' },
      },
      {
        type: 'event_msg',
        timestamp: localTimestamp('2024-01-15'),
        payload: { type: 'task_started' },
      },
      {
        type: 'response_item',
        timestamp: localTimestamp('2024-01-15'),
        payload: { type: 'message', role: 'user', content: 'ship it' },
      },
      {
        type: 'response_item',
        timestamp: localTimestamp('2024-01-15'),
        payload: { type: 'custom_tool_call', name: 'exec', input: "cat > src/app.ts <<'EOF'" },
      },
      {
        type: 'event_msg',
        timestamp: localTimestamp('2024-01-15'),
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 200, output_tokens: 100, cached_input_tokens: 50 },
          },
        },
      },
    ]);

    const day = await parseSessionFile(file);
    const parsed = await parseCodexFile(file);
    const { session, usage } = await readCodexSessionFile(file);
    expect(session.externalId).toBe('codex-1');
    expect(session.cwd).toBe('/work');
    expect(session.inputTokens).toBe(day[0]?.inputTokens);
    expect(session.outputTokens).toBe(day[0]?.outputTokens);
    expect(session.cachedInputTokens).toBe(day[0]?.cachedInputTokens);
    expect(usage?.keys).toEqual([]);
    expect(Object.fromEntries(usage?.days ?? [])).toEqual(Object.fromEntries(parsed.days));
    expect(
      session.fileTouches.some((touch) => touch.path === 'src/app.ts' && touch.kind === 'edit'),
    ).toBe(true);
    expect(session.userMessages).toBe(1);
  });
});

describe('readCursorSessionFile', () => {
  it('resolves the project slug and does not invent tokens', async () => {
    const file = join(
      tmpDir,
      'cursor',
      'projects',
      'Users-me-app',
      'agent-transcripts',
      'abc',
      'abc.jsonl',
    );
    mkdirSync(join(file, '..'), { recursive: true });
    writeJsonl(file, [
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 27, 2026, 10:53 AM (UTC+2)</timestamp>\nfix the button',
            },
          ],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Write', input: { path: 'src/button.tsx' } }],
        },
      },
    ]);

    const { session } = await readCursorSessionFile(
      file,
      (path) => path === '/Users' || path === '/Users/me' || path === '/Users/me/app',
    );
    expect(session.cwd).toBe('/Users/me/app');
    expect(session.cwdUncertain).toBe(false);
    expect(session.provider).toBe('cursor');
    expect(session.tokensKnown).toBe(false);
    expect(session.inputTokens).toBe(0);
    expect(session.fileTouches[0]).toMatchObject({ path: 'src/button.tsx', kind: 'create' });
  });
});

describe('readCursorTracking', () => {
  it('reads daily stats, the latest commit attribution and composer bounds', async () => {
    const databasePath = join(tmpDir, 'state.vscdb');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)');
    database.exec('CREATE TABLE cursorDiskKV (key TEXT, value TEXT)');
    const insert = database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    insert.run(
      'aiCodeTracking.dailyStats.v1.5.2026-04-08',
      JSON.stringify({
        tabSuggestedLines: 10,
        tabAcceptedLines: 4,
        composerSuggestedLines: 2,
        composerAcceptedLines: 1,
      }),
    );
    insert.run(
      'aiCodeTracking.recentCommit',
      JSON.stringify({
        commitHash: 'abc1234',
        repoName: 'aitrack',
        branchName: 'main',
        aiPercentage: '80.00',
        composerLinesAdded: 3,
        composerLinesDeleted: 1,
        tabLinesAdded: 0,
        tabLinesDeleted: 0,
      }),
    );
    database.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      'composerData:abc',
      JSON.stringify({
        fullConversationHeadersOnly: [
          { createdAt: '2026-04-08T10:00:00.000Z' },
          { createdAt: '2026-04-08T11:00:00.000Z' },
        ],
      }),
    );
    database.close();

    const tracking = await readCursorTracking(databasePath);
    expect(tracking.daily[0]).toMatchObject({
      date: '2026-04-08',
      tabSuggestedLines: 10,
      tabAcceptedLines: 4,
    });
    expect(tracking.recentCommit).toMatchObject({
      commitHash: 'abc1234',
      aiPercentage: 80,
      branchName: 'main',
    });
    const bounds = await readComposerBounds(databasePath, 'abc');
    expect(bounds.startedAt).toBe('2026-04-08T10:00:00.000Z');
    expect(bounds.endedAt).toBe('2026-04-08T11:00:00.000Z');
  });
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'claude:1',
    provider: 'claude',
    externalId: '1',
    sourcePath: '/tmp/1.jsonl',
    cwd: '/repo',
    cwdUncertain: false,
    branch: 'main',
    branches: ['main'],
    startedAt: '2024-06-01T12:00:00.000Z',
    endedAt: '2024-06-01T12:20:00.000Z',
    firstEditAt: '2024-06-01T12:05:00.000Z',
    lastEditAt: '2024-06-01T12:10:00.000Z',
    partial: false,
    tokensKnown: true,
    title: 'app.ts',
    turns: [],
    fileTouches: [
      { path: 'src/app.ts', kind: 'edit', at: '2024-06-01T12:10:00.000Z', turnIndex: 0 },
    ],
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 20,
    costUSD: 1,
    models: ['claude'],
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    ...overrides,
  };
}

function commit(overrides: Partial<LinkableCommit> = {}): LinkableCommit {
  return {
    sha: 'abc1234567890',
    authorTime: '2024-06-01T12:12:00.000Z',
    paths: ['src/app.ts'],
    branches: ['main'],
    subject: 'fix the button',
    body: '',
    cursorAiPercentage: null,
    ...overrides,
  };
}

describe('linkSession', () => {
  it('explains a high-confidence link and drops a weak one', () => {
    const linked = linkSession(
      session(),
      { userExcerpt: 'fix the button please now', assistantExcerpt: 'done' },
      [commit()],
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]?.confidence).toBe('high');
    expect(linked[0]?.signals.every((signal) => signal.score > 0)).toBe(true);
    expect(linked[0]?.signals.map((signal) => signal.name)).toEqual(
      expect.arrayContaining(['files', 'time', 'branch']),
    );

    const weak = linkSession(
      session({ fileTouches: [], branches: [], lastEditAt: '2024-06-01T12:00:00.000Z' }),
      { userExcerpt: '', assistantExcerpt: '' },
      [commit({ authorTime: '2024-06-01T18:30:00.000Z', paths: ['other.ts'], branches: [] })],
    );
    expect(weak).toHaveLength(0);
  });

  it('increases the score when file overlap increases', () => {
    const base = session({
      fileTouches: [
        { path: 'src/a.ts', kind: 'edit', at: '2024-06-01T12:10:00.000Z', turnIndex: 0 },
        { path: 'src/b.ts', kind: 'edit', at: '2024-06-01T12:10:00.000Z', turnIndex: 0 },
      ],
    });
    const partial = linkSession(base, { userExcerpt: '', assistantExcerpt: '' }, [
      commit({ paths: ['src/a.ts', 'src/c.ts'], branches: [] }),
    ]);
    const full = linkSession(base, { userExcerpt: '', assistantExcerpt: '' }, [
      commit({ paths: ['src/a.ts', 'src/b.ts'], branches: [] }),
    ]);
    expect(full[0]?.score ?? 0).toBeGreaterThan(partial[0]?.score ?? 0);
  });

  it('raises the score as each signal gets stronger and lists only signals that fired', () => {
    const quiet = { userExcerpt: '', assistantExcerpt: '' };
    const base = session();
    const near = linkSession(base, quiet, [
      commit({ authorTime: '2024-06-01T12:20:00.000Z', branches: [] }),
    ]);
    const later = linkSession(base, quiet, [
      commit({ authorTime: '2024-06-01T14:10:00.000Z', branches: [] }),
    ]);
    expect(near[0]?.score ?? 0).toBeGreaterThan(later[0]?.score ?? 0);

    const branched = linkSession(base, quiet, [commit()]);
    const unbranched = linkSession(base, quiet, [commit({ branches: [] })]);
    expect(branched[0]?.score ?? 0).toBeGreaterThan(unbranched[0]?.score ?? 0);

    const attributed = linkSession(base, quiet, [commit({ branches: [], cursorAiPercentage: 80 })]);
    expect(attributed[0]?.score ?? 0).toBeGreaterThan(unbranched[0]?.score ?? 0);

    const quoted = linkSession(
      base,
      { userExcerpt: '', assistantExcerpt: 'fix the button in the session' },
      [commit({ branches: [], subject: 'fix the button' })],
    );
    expect(quoted[0]?.score ?? 0).toBeGreaterThan(unbranched[0]?.score ?? 0);

    const explained = branched[0];
    if (explained === undefined) throw new Error('expected a link');
    expect(new Set(explained.signals.map((signal) => signal.name)).size).toBe(
      explained.signals.length,
    );
    const summed = explained.signals.reduce((sum, signal) => sum + signal.weight * signal.score, 0);
    expect(explained.score).toBeCloseTo(Math.round(summed * 10_000) / 10_000);
    for (const signal of explained.signals) {
      expect(signal.score).toBeGreaterThan(0);
      expect(signal.detail.length).toBeGreaterThan(0);
    }
    const absent = unbranched[0]?.signals.map((signal) => signal.name) ?? [];
    expect(absent).not.toContain('branch');
    expect(absent).not.toContain('cursor');
    expect(absent).not.toContain('text');
  });

  it('splits share across two sessions that link the same commit', () => {
    const first = linkSession(session(), { userExcerpt: '', assistantExcerpt: '' }, [commit()]);
    const second = linkSession(
      session({ id: 'claude:2' }),
      { userExcerpt: '', assistantExcerpt: '' },
      [commit()],
    );
    const shares = linkSession(session(), { userExcerpt: '', assistantExcerpt: '' }, [commit()]);
    expect(shares[0]?.share).toBe(1);
    const combined = [...first, ...second];
    const total = combined.reduce((sum, link) => sum + link.score, 0);
    expect(LINK_WEIGHTS.files + LINK_WEIGHTS.time + LINK_WEIGHTS.branch).toBeCloseTo(0.85);
    expect(total).toBeGreaterThan(0);
  });

  it('records text, cursor, and a commit a few hours later', () => {
    const prompt = 'please rewrite the button label so it says save changes now';
    const linked = linkSession(
      session({
        fileTouches: [
          { path: '/repo/src/app.ts', kind: 'edit', at: '2024-06-01T12:10:00.000Z', turnIndex: 0 },
          { path: 'notes.md', kind: 'read', at: '2024-06-01T12:10:00.000Z', turnIndex: 0 },
        ],
      }),
      { userExcerpt: prompt, assistantExcerpt: 'fix the button in src/app.ts' },
      [
        commit({
          authorTime: '2024-06-01T14:00:00.000Z',
          paths: ['src/app.ts'],
          branches: [],
          body: prompt,
          cursorAiPercentage: 40,
        }),
      ],
      { repoRoot: '/repo' },
    );
    const names = linked[0]?.signals.map((signal) => signal.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['files', 'time', 'text', 'cursor']));
    expect(linked[0]?.signals.find((signal) => signal.name === 'time')?.detail).toContain(
      'h after',
    );
    expect(
      linkSession(session({ startedAt: null }), { userExcerpt: '', assistantExcerpt: '' }, [
        commit(),
      ]),
    ).toEqual([]);
    expect(normalizePath('src\\app.ts', null)).toBe('src/app.ts');
    expect(normalizePath('./src/app.ts', '/repo')).toBe('src/app.ts');
    expect(normalizePath('/repo/', '/repo')).toBe('');
    expect(normalizePath('/repo/src/app.ts', '/repo/')).toBe('src/app.ts');
  });
});

describe('buildLeverageReport', () => {
  it('compares linked commits with the human baseline and flags a small sample', () => {
    const report = buildLeverageReport({
      now: '2024-06-10T00:00:00.000Z',
      window: { from: null, to: null },
      sessions: [
        {
          id: 'claude:1',
          provider: 'claude',
          repoId: 'repo',
          startedAt: '2024-06-01T12:00:00.000Z',
          endedAt: '2024-06-01T12:20:00.000Z',
          firstEditAt: '2024-06-01T12:05:00.000Z',
          turnTimestamps: ['2024-06-01T12:00:00.000Z', '2024-06-01T12:10:00.000Z'],
          turns: 4,
          costUsd: 2,
          rating: 'kept',
        },
        {
          id: 'claude:2',
          provider: 'claude',
          repoId: 'repo',
          startedAt: '2024-06-02T12:00:00.000Z',
          endedAt: '2024-06-02T12:10:00.000Z',
          firstEditAt: null,
          turnTimestamps: [],
          turns: 1,
          costUsd: 3,
          rating: 'discarded',
        },
      ],
      commits: [
        {
          id: 'c1',
          repoId: 'repo',
          sha: 'a',
          authorTime: '2024-06-01T12:12:00.000Z',
          insertions: 10,
          deletions: 2,
          testFilesChanged: 1,
          testLines: 4,
          isRevert: false,
          churn7: 0.2,
          churn30: null,
        },
        {
          id: 'c2',
          repoId: 'repo',
          sha: 'b',
          authorTime: '2024-06-03T12:00:00.000Z',
          insertions: 4,
          deletions: 0,
          testFilesChanged: 0,
          testLines: 0,
          isRevert: false,
          churn7: 0.5,
          churn30: null,
        },
      ],
      links: [
        {
          sessionId: 'claude:1',
          commitId: 'c1',
          confidence: 'high',
          decidedBy: 'auto',
          rejected: false,
        },
      ],
    });

    expect(report.linkedCommits).toBe(1);
    expect(report.humanCommits).toBe(1);
    expect(report.confidence).toBe('low');
    const churn = report.comparisons.find((row) => row.id === 'churn-7');
    expect(churn?.linked).toBeCloseTo(0.2);
    expect(churn?.human).toBeCloseTo(0.5);
    const testLines = report.comparisons.find((row) => row.id === 'test-lines');
    expect(testLines?.linked).toBeCloseTo(4 / 12);
    expect(testLines?.human).toBe(0);
    expect(churn?.rule).toContain('blame');
    const lead = report.speed.find((row) => row.id === 'lead-time');
    expect(lead?.value).toBeCloseTo(7);
    expect(lead?.caveat.length).toBeGreaterThan(0);
    const unshipped = report.cost.find((row) => row.id === 'unshipped');
    expect(unshipped?.value).toBe(3);
    expect(report.ratings.kept).toBe(1);
    const rules = [
      ...report.comparisons.map((row) => `${row.id}: ${row.rule}`),
      ...report.speed.map((row) => `${row.id}: ${row.rule}`),
      ...report.quality.map((row) => `${row.id}: ${row.rule}`),
      ...report.cost.map((row) => `${row.id}: ${row.rule}`),
    ];
    expect(rules).toMatchSnapshot();
    expect(median([1, 3, 2])).toBe(2);
    expect(cursorAcceptance(10, 4).value).toBeCloseTo(0.4);
  });

  it('ignores low-confidence links unless a person confirmed them', () => {
    const base = {
      now: '2024-06-10T00:00:00.000Z',
      window: { from: null, to: null },
      sessions: [
        {
          id: 's',
          provider: 'claude' as const,
          repoId: 'repo',
          startedAt: '2024-06-01T12:00:00.000Z',
          endedAt: '2024-06-01T12:20:00.000Z',
          firstEditAt: '2024-06-01T12:05:00.000Z',
          turnTimestamps: [],
          turns: 1,
          costUsd: 1,
          rating: null,
        },
      ],
      commits: [
        {
          id: 'c',
          repoId: 'repo',
          sha: 'a',
          authorTime: '2024-06-01T12:12:00.000Z',
          insertions: 1,
          deletions: 0,
          testFilesChanged: 0,
          testLines: 0,
          isRevert: false,
          churn7: null,
          churn30: null,
        },
      ],
    };
    const ignored = buildLeverageReport({
      ...base,
      links: [
        { sessionId: 's', commitId: 'c', confidence: 'low', decidedBy: 'auto', rejected: false },
      ],
    });
    const confirmed = buildLeverageReport({
      ...base,
      links: [
        { sessionId: 's', commitId: 'c', confidence: 'low', decidedBy: 'user', rejected: false },
      ],
    });
    expect(ignored.linkedCommits).toBe(0);
    expect(confirmed.linkedCommits).toBe(1);
  });
});

for (const zone of EXTREME_TIME_ZONES) {
  describe(`local commit days in ${zone}`, () => {
    useTimeZone(zone);

    it('keeps the local calendar day', () => {
      const days = commitsPerLocalDay([{ authorTime: localTimestamp('2024-01-15', 0) }]);
      expect(days.get('2024-01-15')).toBe(1);
    });
  });
}
