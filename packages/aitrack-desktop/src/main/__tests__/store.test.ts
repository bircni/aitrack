import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { CursorCommitAttribution, ParsedCommit, Session } from 'aitrack-lib/sessions/index';
import { afterEach, describe, expect, it } from 'vitest';

import { localDay } from '../budget.js';
import { APP_WRITE_PATHS, DesktopStore } from '../store.js';

let dir: string;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DesktopStore', () => {
  it('keeps a rating when the same session is read again', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    store.upsertSession(session(), null);
    expect(store.unratedSessionCount()).toBe(1);
    store.rateSession('claude:1', 'kept', null);
    expect(store.unratedSessionCount()).toBe(0);
    store.upsertSession(session(), null);
    expect(store.getSession('claude:1')?.rating).toBe('kept');
    expect(store.listSessions()[0]?.title).toBe('app.ts');
    store.close();
  });

  it('keeps a hand-made link when automatic linking runs again', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    const repoId = store.upsertRepo('/repo', 'demo', null);
    store.upsertSession(session(), repoId);
    store.replaceCommits(repoId, [commit()], () => false, '2024-01-01T00:00:00.000Z');
    const imported = store.listCommits()[0];
    if (imported === undefined) throw new Error('commit was not imported');
    store.decideLink(imported.id, 'claude:1', 'link');
    store.replaceAutoLinks(repoId, [
      {
        commitId: imported.id,
        sessionId: 'claude:1',
        sha: 'abc',
        score: 0.2,
        confidence: 'low',
        signals: [],
        share: 1,
      },
    ]);
    const linked = store.listCommits()[0];
    expect(linked?.linked).toBe(true);
    expect(linked?.sessionId).toBe('claude:1');
    expect(store.getSession('claude:1')?.links[0]?.explanation).toBe(
      'You linked this session by hand.',
    );
    expect(store.getSession('claude:1')?.links[0]?.decidedBy).toBe('user');
    const other = session();
    other.id = 'claude:2';
    other.externalId = '2';
    other.title = 'notes';
    store.upsertSession(other, repoId);
    store.replaceAutoLinks(repoId, [
      {
        commitId: imported.id,
        sessionId: 'claude:2',
        sha: 'abc',
        score: 0.4,
        confidence: 'medium',
        signals: [{ name: 'files', weight: 0.45, score: 1, detail: '1 of 1 files' }],
        share: 1,
      },
    ]);
    expect(store.linksForCommit(imported.id).map((link) => link.sessionId)).toEqual([
      'claude:1',
      'claude:2',
    ]);
    expect(store.linksForCommit(imported.id)[0]?.title).toBe('app.ts');
    expect(store.linksForCommit(imported.id)[1]?.explanation).toBe('1 of 1 files');
    store.close();
  });

  it('keeps a commit that leaves history and drops it from linking', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    const repoId = store.upsertRepo('/repo', 'demo', null);
    const kept = commit();
    const gone = commit();
    gone.sha = 'def';
    gone.subject = 'removed';
    const since = '2024-01-01T00:00:00.000Z';
    store.replaceCommits(repoId, [kept, gone], () => false, since);
    store.replaceCommits(repoId, [kept], () => false, since);
    const listed = store.listCommits();
    expect(listed.find((row) => row.sha === 'def')?.unreachable).toBe(true);
    expect(listed.find((row) => row.sha === 'abc')?.unreachable).toBe(false);
    expect(store.commitsForRepo(repoId).map((row) => row.sha)).toEqual(['abc']);
    store.close();
  });

  it('keeps Cursor commit snapshots after the latest key moves on', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    const first = cursorCommit('abc', 80);
    expect(store.snapshotCursorCommit(first)).toBe(true);
    expect(store.snapshotCursorCommit(first)).toBe(false);
    expect(store.snapshotCursorCommit(cursorCommit('def', 40))).toBe(true);
    expect(store.snapshotCursorCommit({ ...first, aiPercentage: 90 })).toBe(true);
    expect(store.cursorCommitPercentages()).toEqual(
      new Map([
        ['abc', 90],
        ['def', 40],
      ]),
    );
    store.close();
  });

  it('keeps a sidechain turn and every branch the session used', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    const recorded = session();
    recorded.branch = 'feature';
    recorded.branches = ['main', 'feature'];
    recorded.turns = [
      {
        index: 0,
        startedAt: '2024-06-01T12:00:00.000Z',
        endedAt: '2024-06-01T12:01:00.000Z',
        role: 'assistant',
        model: 'claude',
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        rawInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        costUSD: null,
        toolCalls: 0,
        sidechain: true,
      },
    ];
    store.upsertSession(recorded, null);
    const loaded = store.getSession('claude:1');
    expect(loaded?.branches).toEqual(['main', 'feature']);
    expect(loaded?.turns[0]?.sidechain).toBe(true);
    store.close();
  });

  it('counts model cost only for sessions that started in the window', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    const june = session();
    june.startedAt = '2024-06-01T12:00:00.000Z';
    june.models = ['claude-june'];
    const july = session();
    july.id = 'claude:2';
    july.externalId = '2';
    july.startedAt = '2024-07-01T12:00:00.000Z';
    july.models = ['claude-july'];
    july.costUSD = 0.4;
    store.upsertSession(june, null);
    store.upsertSession(july, null);
    const juneDay = localDay(new Date(june.startedAt));
    const inJune = store.modelCosts(juneDay, juneDay);
    expect(inJune.map((row) => row.model)).toEqual(['claude-june']);
    expect(
      store
        .modelCosts(null, null)
        .map((row) => row.model)
        .toSorted(),
    ).toEqual(['claude-july', 'claude-june']);
    store.close();
  });

  it('records whether git import worked and when it last succeeded', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    const repoId = store.upsertRepo('/repo', 'demo', null);
    store.recordRepoGit(repoId, false, 'git log failed');
    const failed = store.listRepos()[0];
    expect(failed?.gitOk).toBe(false);
    expect(failed?.gitDetail).toBe('git log failed');
    expect(failed?.importedAt).toBeNull();
    store.recordRepoGit(repoId, true, null);
    const ok = store.listRepos()[0];
    expect(ok?.gitOk).toBe(true);
    expect(ok?.gitDetail).toBeNull();
    expect(ok?.importedAt).not.toBeNull();
    store.close();
  });

  it('keeps the commit a revert points at', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    const repoId = store.upsertRepo('/repo', 'demo', null);
    const reverted = commit();
    reverted.isRevert = true;
    reverted.revertOf = 'deadbeef';
    reverted.subject = 'Revert "add app"';
    store.replaceCommits(repoId, [reverted], () => false, '2024-01-01T00:00:00.000Z');
    const imported = store.listCommits()[0];
    expect(imported?.isRevert).toBe(true);
    expect(imported?.revertOf).toBe('deadbeef');
    store.close();
  });

  it('adds commit time columns when an older database is opened', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const path = join(dir, 'desktop.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations (version) VALUES (8);
      CREATE TABLE commits (
        id INTEGER PRIMARY KEY,
        repo_id TEXT NOT NULL,
        sha TEXT NOT NULL,
        author_time TEXT NOT NULL,
        subject TEXT NOT NULL,
        files_json TEXT NOT NULL,
        insertions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        test_files INTEGER NOT NULL,
        is_merge INTEGER NOT NULL,
        is_revert INTEGER NOT NULL,
        revert_of TEXT,
        unreachable INTEGER NOT NULL DEFAULT 0,
        churn7 REAL,
        churn30 REAL,
        churn_head TEXT,
        churn_note TEXT,
        UNIQUE (repo_id, sha)
      );
    `);
    db.close();
    const store = DesktopStore.open(path);
    const repoId = store.upsertRepo('/repo', 'demo', null);
    const row = commit();
    row.body = 'kept after migration';
    store.replaceCommits(repoId, [row], () => false, '2024-01-01T00:00:00.000Z');
    expect(store.commitsForRepo(repoId)[0]?.body).toBe('kept after migration');
    expect(store.latestCommitTime(repoId)).toBe(row.commitTime);
    store.close();
  });

  it('keeps commit time, parents, author, and message for later linking', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    const repoId = store.upsertRepo('/repo', 'demo', null);
    const row = commit();
    row.authorTime = '2024-06-01T10:00:00.000Z';
    row.commitTime = '2024-06-01T12:12:00.000Z';
    row.parents = ['parentsha'];
    row.authorEmail = 'ada@example.com';
    row.body = 'Quoted from the prompt in the commit message';
    store.replaceCommits(repoId, [row], () => false, '2024-01-01T00:00:00.000Z');
    const imported = store.commitsForRepo(repoId)[0];
    expect(imported?.commitTime).toBe('2024-06-01T12:12:00.000Z');
    expect(imported?.authorEmail).toBe('ada@example.com');
    expect(imported?.parents).toEqual(['parentsha']);
    expect(imported?.body).toContain('Quoted from the prompt');
    expect(store.latestCommitTime(repoId)).toBe('2024-06-01T12:12:00.000Z');
    store.close();
  });

  it('counts lines changed in test files', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    const repoId = store.upsertRepo('/repo', 'demo', null);
    const row = commit();
    row.files = [
      { path: 'src/app.ts', insertions: 3, deletions: 1 },
      { path: 'src/app.test.ts', insertions: 2, deletions: 1 },
    ];
    store.replaceCommits(
      repoId,
      [row],
      (path) => path.includes('.test.'),
      '2024-01-01T00:00:00.000Z',
    );
    const imported = store.commitsForRepo(repoId)[0];
    expect(imported?.testFiles).toBe(1);
    expect(imported?.testLines).toBe(3);
    expect(store.metricInputs().commits[0]?.testLines).toBe(3);
    store.close();
  });

  it('keeps the reason churn was measured or skipped', () => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-store-'));
    const store = DesktopStore.open(join(dir, 'desktop.sqlite'));
    const repoId = store.upsertRepo('/repo', 'demo', null);
    store.replaceCommits(repoId, [commit()], () => false, '2024-01-01T00:00:00.000Z');
    const imported = store.listCommits()[0];
    if (imported === undefined) throw new Error('commit was not imported');
    store.setChurn(imported.id, null, null, 'abc', 'src/app.ts is over 20000 lines');
    expect(store.listCommits()[0]?.churnNote).toBe('src/app.ts is over 20000 lines');
    expect(store.listCommits()[0]?.churnHead).toBe('abc');
    expect(store.commitsForRepo(repoId)[0]?.churn7).toBeNull();
    store.close();
  });

  it('names every path the app may write', () => {
    expect(APP_WRITE_PATHS).toEqual([
      'desktop.sqlite',
      'desktop.sqlite-wal',
      'desktop.sqlite-shm',
      'cache',
      'pending',
      'repo',
    ]);
  });
});

function cursorCommit(sha: string, aiPercentage: number): CursorCommitAttribution {
  return {
    commitHash: sha,
    repoName: 'demo',
    branchName: 'main',
    aiPercentage,
    composerLinesAdded: 10,
    composerLinesDeleted: 0,
    tabLinesAdded: 1,
    tabLinesDeleted: 0,
  };
}

function commit(): ParsedCommit {
  return {
    sha: 'abc',
    parents: [],
    authorTime: '2024-06-01T12:12:00.000Z',
    commitTime: '2024-06-01T12:12:00.000Z',
    authorEmail: 'ada@example.com',
    subject: 'add app',
    body: '',
    files: [{ path: 'src/app.ts', insertions: 3, deletions: 0 }],
    isMerge: false,
    isRevert: false,
    revertOf: null,
  };
}

function session(): Session {
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
    endedAt: '2024-06-01T12:10:00.000Z',
    firstEditAt: '2024-06-01T12:05:00.000Z',
    lastEditAt: '2024-06-01T12:08:00.000Z',
    partial: false,
    tokensKnown: true,
    title: 'app.ts',
    turns: [],
    fileTouches: [],
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 2,
    costUSD: 0.1,
    models: ['claude'],
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
  };
}
