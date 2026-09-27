import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { writeJsonl } from '@aitrack/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { measureBlame, readBranchesContaining, readRepoRoot } from '../git/inspect.js';
import { parseBranchList, parseGitLog } from '../git/parse.js';
import { activeMillis, buildLeverageReport, cursorAcceptance, median } from '../metrics/compute.js';
import { readClaudeSessionFile } from '../readers/claude.js';
import { readCodexSessionFile } from '../readers/codex.js';
import { applyComposerBounds, readCursorSessionFile } from '../readers/cursor.js';
import { readComposerBounds, readCursorTracking } from '../readers/cursorState.js';
import { resolveEncodedPath } from '../slug.js';

let tmpDir = '';

afterEach(() => {
  if (tmpDir !== '') rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('session readers cover the awkward shapes', () => {
  it('reads a Codex rollout with a rollback, a quoted prompt, and a function call', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aitrack-cov-'));
    const file = join(tmpDir, 'rollout.jsonl');
    writeJsonl(file, [
      { type: 'session_meta', payload: { runtime_workspace_roots: ['', '/work'] } },
      { type: 'turn_context', payload: { model: '' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'event_msg',
        timestamp: '2024-06-01T12:00:00.000Z',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 10, output_tokens: 4 } },
        },
      },
      {
        type: 'event_msg',
        timestamp: '2024-06-01T12:01:00.000Z',
        payload: { type: 'task_started' },
      },
      {
        type: 'event_msg',
        timestamp: '2024-06-01T12:02:00.000Z',
        payload: { type: 'task_complete' },
      },
      {
        type: 'event_msg',
        timestamp: '2024-06-01T12:03:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 3, output_tokens: 1, cached_input_tokens: 1 },
            last_token_usage: { input_tokens: 3, output_tokens: 1, cached_input_tokens: 1 },
          },
        },
      },
      {
        type: 'response_item',
        timestamp: '2024-06-01T12:04:00.000Z',
        payload: { type: 'message', message: { role: 'assistant', content: 'wrote the file' } },
      },
      {
        type: 'response_item',
        timestamp: '2024-06-01T12:05:00.000Z',
        payload: { type: 'function_call', arguments: 'cat src/old.ts' },
      },
      { type: 'response_item', payload: { type: 'custom_tool_call' } },
      { type: 'noise' },
    ]);
    const { session, signals } = await readCodexSessionFile(file);
    expect(session.cwd).toBe('/work');
    expect(session.cwdUncertain).toBe(false);
    expect(session.outputTokens).toBeGreaterThan(0);
    expect(signals.assistantExcerpt).toContain('wrote');
    expect(session.fileTouches.some((touch) => touch.kind === 'read')).toBe(true);
  });

  it('keeps the richer Claude usage, flags a resumed transcript, and skips empty usage', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aitrack-cov-'));
    const file = join(tmpDir, 'sess.jsonl');
    writeJsonl(file, [
      { type: 'user', sessionId: 'one', isSidechain: true, message: { content: '' } },
      {
        type: 'assistant',
        sessionId: 'two',
        timestamp: '2024-06-01T12:00:00.000Z',
        requestId: 'r',
        message: {
          id: 'm',
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: 'text', text: 'short' }],
        },
      },
      {
        type: 'assistant',
        sessionId: 'two',
        timestamp: '2024-06-01T12:01:00.000Z',
        requestId: 'r',
        message: {
          id: 'm',
          model: 'claude-3-5-sonnet-20241022',
          usage: {
            input_tokens: 20,
            output_tokens: 8,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
          },
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts' } }],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'loose' }] } },
    ]);
    const { session } = await readClaudeSessionFile(file);
    expect(session.partial).toBe(true);
    expect(session.outputTokens).toBe(8);
    expect(session.fileTouches[0]?.path).toBe('src/app.ts');
  });

  it('treats an unrecognized Cursor object as partial and fills bounds', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aitrack-cov-'));
    const file = join(tmpDir, 'notes.jsonl');
    writeJsonl(file, [{ hello: true }]);
    const { session } = await readCursorSessionFile(file, () => false);
    expect(session.partial).toBe(true);
    expect(session.cwd).toBeNull();
    const bounded = applyComposerBounds(
      { ...session, startedAt: null, endedAt: null },
      '2024-06-01T12:00:00.000Z',
      null,
    );
    expect(bounded.startedAt).toBe('2024-06-01T12:00:00.000Z');
    expect(bounded.endedAt).toBe('2024-06-01T12:00:00.000Z');
    expect(
      applyComposerBounds(bounded, '1999-01-01T00:00:00.000Z', '1999-01-02T00:00:00.000Z')
        .startedAt,
    ).toBe('2024-06-01T12:00:00.000Z');
  });
});

describe('cursor state tolerates junk rows', () => {
  it('skips invalid JSON, empty hashes, and a missing composer', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aitrack-cov-'));
    const databasePath = join(tmpDir, 'state.vscdb');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE ItemTable (key TEXT, value BLOB)');
    database.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
    const insert = database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    insert.run('aiCodeTracking.dailyStats.v1.5.2024-06-01', 'not-json');
    insert.run(
      'aiCodeTracking.dailyStats.v1.5.2024-06-02',
      JSON.stringify({ tabSuggestedLines: 'nope' }),
    );
    insert.run('aiCodeTracking.recentCommit', JSON.stringify({ commitHash: '' }));
    insert.run(
      'aiCodeTracking.recentCommit',
      Buffer.from(JSON.stringify({ commitHash: 'abc', aiPercentage: 'nope' })),
    );
    database
      .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
      .run('composerData:empty', JSON.stringify({ fullConversationHeadersOnly: 'no' }));
    database.close();

    const tracking = await readCursorTracking(databasePath);
    expect(tracking.daily).toHaveLength(1);
    expect(tracking.daily[0]?.tabSuggestedLines).toBe(0);
    expect(tracking.recentCommit?.commitHash).toBe('abc');
    expect(tracking.recentCommit?.aiPercentage).toBeNull();
    const bounds = await readComposerBounds(databasePath, 'empty');
    expect(bounds.startedAt).toBeNull();
    const missing = await readComposerBounds(databasePath, 'gone');
    expect(missing.endedAt).toBeNull();
  });

  it('returns nothing when the tables are absent', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aitrack-cov-'));
    const databasePath = join(tmpDir, 'empty.vscdb');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE dummy (id INTEGER)');
    database.close();
    const tracking = await readCursorTracking(databasePath);
    expect(tracking.daily).toEqual([]);
    expect(tracking.recentCommit).toBeNull();
  });
});

describe('slug resolution', () => {
  it('handles an empty slug, a Windows drive, and two equally real paths', () => {
    expect(resolveEncodedPath('-', () => true)).toEqual({
      path: null,
      uncertain: false,
      candidates: [],
    });
    expect(resolveEncodedPath('---', () => true)).toEqual({
      path: null,
      uncertain: false,
      candidates: [],
    });
    const drive = resolveEncodedPath(
      'c-Users-me',
      (path) => path === 'C:' || path === 'C:/Users' || path === 'C:/Users/me',
      'win32',
    );
    expect(drive.path).toBe('C:/Users/me');
    const ambiguous = resolveEncodedPath(
      'a-b',
      (path) => path === '/a' || path === '/a/b' || path === '/a-b',
    );
    expect(ambiguous.uncertain).toBe(true);
    expect(ambiguous.candidates).toHaveLength(2);
    expect(resolveEncodedPath('missing', () => false).uncertain).toBe(true);
  });
});

describe('git parsers and blame limits', () => {
  it('drops a broken record and a non-numstat line', () => {
    const output = [
      '\u001Enot-a-record',
      '\u001Eabc\u001Fdef\u001Fnope\u001F1\u001Fa@b.c\u001Fsubject\u001F\u001C',
      '\u001Eabcdef1234567890\u001Fparent\u001F1700000000\u001F1700000001\u001Fa@b.c\u001FRevert "fix"\u001Fbody\u001C',
      'not a stat',
      '1\t2\tsrc/app.ts',
    ].join('\n');
    const commits = parseGitLog(output);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.isRevert).toBe(true);
    expect(commits[0]?.files).toHaveLength(1);
    expect(parseBranchList('*\n  (HEAD detached)\n  remotes/origin/main\n  main')).toEqual([
      'main',
    ]);
  });

  it('skips blame once a file is past the line cap and ignores a missing commit', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aitrack-cov-'));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    };
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir, env });
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'src', 'big.ts'), 'line\n'.repeat(3_000));
    execFileSync('git', ['add', 'src/big.ts'], { cwd: tmpDir, env });
    execFileSync('git', ['commit', '-m', 'big'], { cwd: tmpDir, env });
    const root = await readRepoRoot(tmpDir);
    expect(root).not.toBeNull();
    const skipped = await measureBlame(root ?? tmpDir, 'HEAD', 'src/big.ts');
    expect(skipped.skipped).toBe(true);
    expect(skipped.reason).toContain('over');
    expect(await readBranchesContaining(tmpDir, 'not-a-commit')).toEqual([]);
  });
});

describe('metric edges', () => {
  it('filters by repo, provider, and window, and handles empty samples', () => {
    expect(median([])).toBeNull();
    expect(median([4, 8])).toBe(6);
    expect(activeMillis(['nope', '2024-06-01T12:00:00.000Z', '2024-06-01T12:10:00.000Z'])).toBe(
      10 * 60 * 1000,
    );
    expect(activeMillis(['2024-06-01T12:00:00.000Z', '2024-06-01T13:00:00.000Z'])).toBe(0);
    expect(cursorAcceptance(0, 0).value).toBeNull();

    const report = buildLeverageReport({
      now: '2024-06-10T00:00:00.000Z',
      window: { from: '2024-06-02T00:00:00.000Z', to: '2024-06-03T00:00:00.000Z' },
      repoId: 'repo',
      provider: 'codex',
      sessions: [
        {
          id: 'claude:1',
          provider: 'claude',
          repoId: 'repo',
          startedAt: '2024-06-02T12:00:00.000Z',
          endedAt: '2024-06-02T12:10:00.000Z',
          firstEditAt: null,
          turnTimestamps: [],
          turns: 1,
          costUsd: 1,
          rating: null,
        },
        {
          id: 'codex:1',
          provider: 'codex',
          repoId: 'other',
          startedAt: null,
          endedAt: null,
          firstEditAt: null,
          turnTimestamps: [],
          turns: 1,
          costUsd: 1,
          rating: 'reworked',
        },
      ],
      commits: [],
      links: [],
    });
    expect(report.linkedCommits).toBe(0);
    expect(report.ratings.reworked).toBe(0);
  });
});
