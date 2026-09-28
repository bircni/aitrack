import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { isRecord } from 'aitrack-lib/data/guards';
import type {
  CommitLink,
  CursorCommitAttribution,
  ParsedCommit,
  FileTouchKind,
  Session,
  SessionRating,
} from 'aitrack-lib/sessions/index';

import { localDay } from './budget.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS source_files (
  path TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  session_id TEXT,
  parsed_offset INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  cwd TEXT,
  cwd_uncertain INTEGER NOT NULL,
  branch TEXT,
  branches_json TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  first_edit_at TEXT,
  last_edit_at TEXT,
  partial INTEGER NOT NULL,
  tokens_known INTEGER NOT NULL,
  title TEXT,
  input_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  models_json TEXT NOT NULL,
  user_messages INTEGER NOT NULL,
  assistant_messages INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL,
  rating TEXT,
  rating_note TEXT,
  rated_at TEXT,
  repo_id TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  role TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL,
  tool_calls INTEGER NOT NULL,
  sidechain INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS file_touches (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT
);
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  remote_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  test_globs_json TEXT NOT NULL DEFAULT '[]',
  last_seen TEXT,
  git_ok INTEGER NOT NULL DEFAULT 0,
  git_detail TEXT,
  imported_at TEXT
);
CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  author_time TEXT NOT NULL,
  commit_time TEXT,
  author_email TEXT,
  parent_shas_json TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  files_json TEXT NOT NULL,
  insertions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  test_files INTEGER NOT NULL,
  test_lines INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS commit_links (
  commit_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  score REAL NOT NULL,
  confidence TEXT NOT NULL,
  explanation_json TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  rejected INTEGER NOT NULL DEFAULT 0,
  share REAL NOT NULL,
  PRIMARY KEY (commit_id, session_id)
);
CREATE TABLE IF NOT EXISTS usage_days (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  PRIMARY KEY (day, provider)
);
CREATE TABLE IF NOT EXISTS cursor_daily (
  day TEXT PRIMARY KEY,
  tab_suggested INTEGER NOT NULL,
  tab_accepted INTEGER NOT NULL,
  composer_suggested INTEGER NOT NULL,
  composer_accepted INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursor_commits (
  sha TEXT PRIMARY KEY,
  repo_name TEXT,
  branch TEXT,
  ai_percentage REAL,
  composer_added INTEGER NOT NULL,
  composer_deleted INTEGER NOT NULL,
  tab_added INTEGER NOT NULL,
  tab_deleted INTEGER NOT NULL,
  seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ingest_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metric_daily (
  day TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL,
  inputs_json TEXT NOT NULL,
  PRIMARY KEY (day, repo_id, provider, metric)
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS commits_repo_time ON commits(repo_id, author_time);
CREATE INDEX IF NOT EXISTS metric_daily_day ON metric_daily(day);
`;

export interface SessionRow {
  id: string;
  provider: 'claude' | 'codex' | 'cursor';
  title: string | null;
  cwd: string | null;
  branch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  firstEditAt: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  tokensKnown: boolean;
  rating: SessionRating | null;
  ratingNote: string | null;
  linkedCommits: number;
  repoId: string | null;
  toolCalls: number;
  userMessages: number;
  assistantMessages: number;
}

export interface SessionDetail extends SessionRow {
  turns: Array<{
    index: number;
    role: string;
    startedAt: string | null;
    model: string | null;
    toolCalls: number;
    sidechain: boolean;
  }>;
  branches: string[];
  files: Array<{ path: string; kind: string }>;
  links: Array<{
    sha: string;
    subject: string;
    score: number;
    confidence: string;
    explanation: string;
    decidedBy: string;
  }>;
}

export interface CommitRow {
  id: number;
  repoId: string;
  sha: string;
  authorTime: string;
  commitTime: string | null;
  authorEmail: string | null;
  parents: string[];
  body: string;
  subject: string;
  insertions: number;
  deletions: number;
  testFiles: number;
  testLines: number;
  isRevert: boolean;
  revertOf: string | null;
  churn7: number | null;
  churn30: number | null;
  churnHead: string | null;
  churnNote: string | null;
  linked: boolean;
  sessionId: string | null;
  linkScore: number | null;
  unreachable: boolean;
}

export interface RepoRow {
  id: string;
  rootPath: string;
  name: string;
  remoteUrl: string | null;
  enabled: boolean;
  testGlobs: string[];
  lastSeen: string | null;
  gitOk: boolean;
  gitDetail: string | null;
  importedAt: string | null;
}

export interface UsageDayRow {
  day: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

/** Paths the desktop app is allowed to create. Tests assert this list. */
export const APP_WRITE_PATHS = [
  'desktop.sqlite',
  'desktop.sqlite-wal',
  'desktop.sqlite-shm',
  'cache',
  'pending',
  'repo',
] as const;

function migrate(db: DatabaseSync): void {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  const current = row.version ?? 0;
  if (current < 1) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
  }
  if (current < 2) {
    const columns = db.prepare('PRAGMA table_info(commits)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'unreachable')) {
      db.exec('ALTER TABLE commits ADD COLUMN unreachable INTEGER NOT NULL DEFAULT 0');
    }
    db.prepare('INSERT INTO schema_migrations (version) VALUES (2)').run();
  }
  if (current < 3) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (3)').run();
  }
  if (current < 4) {
    const columns = db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'sidechain')) {
      db.exec('ALTER TABLE turns ADD COLUMN sidechain INTEGER NOT NULL DEFAULT 0');
    }
    db.prepare('INSERT INTO schema_migrations (version) VALUES (4)').run();
  }
  if (current < 5) {
    const columns = db.prepare('PRAGMA table_info(source_files)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'parsed_offset')) {
      db.exec('ALTER TABLE source_files ADD COLUMN parsed_offset INTEGER NOT NULL DEFAULT 0');
    }
    db.prepare('INSERT INTO schema_migrations (version) VALUES (5)').run();
  }
  if (current < 6) {
    const columns = db.prepare('PRAGMA table_info(repos)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('git_ok')) {
      db.exec('ALTER TABLE repos ADD COLUMN git_ok INTEGER NOT NULL DEFAULT 0');
    }
    if (!names.has('git_detail')) db.exec('ALTER TABLE repos ADD COLUMN git_detail TEXT');
    if (!names.has('imported_at')) db.exec('ALTER TABLE repos ADD COLUMN imported_at TEXT');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (6)').run();
  }
  if (current < 7) {
    const columns = db.prepare('PRAGMA table_info(commits)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'churn_note')) {
      db.exec('ALTER TABLE commits ADD COLUMN churn_note TEXT');
    }
    db.prepare('INSERT INTO schema_migrations (version) VALUES (7)').run();
  }
  if (current < 8) {
    const columns = db.prepare('PRAGMA table_info(commits)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'revert_of')) {
      db.exec('ALTER TABLE commits ADD COLUMN revert_of TEXT');
    }
    db.prepare('INSERT INTO schema_migrations (version) VALUES (8)').run();
  }
  if (current < 9) {
    const columns = db.prepare('PRAGMA table_info(commits)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('commit_time')) db.exec('ALTER TABLE commits ADD COLUMN commit_time TEXT');
    if (!names.has('author_email')) db.exec('ALTER TABLE commits ADD COLUMN author_email TEXT');
    if (!names.has('parent_shas_json')) {
      db.exec("ALTER TABLE commits ADD COLUMN parent_shas_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!names.has('body')) db.exec("ALTER TABLE commits ADD COLUMN body TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE INDEX IF NOT EXISTS commits_repo_time ON commits(repo_id, commit_time)');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (9)').run();
  }
  if (current < 10) {
    const columns = db.prepare('PRAGMA table_info(commits)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'test_lines')) {
      db.exec('ALTER TABLE commits ADD COLUMN test_lines INTEGER NOT NULL DEFAULT 0');
    }
    db.prepare('INSERT INTO schema_migrations (version) VALUES (10)').run();
  }
}

export class DesktopStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): DesktopStore {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    migrate(db);
    return new DesktopStore(db);
  }

  close(): void {
    this.db.close();
  }

  log(kind: string, detail: string): void {
    this.db
      .prepare('INSERT INTO ingest_log (at, kind, detail) VALUES (?, ?, ?)')
      .run(new Date().toISOString(), kind, detail);
  }

  recentLog(limit = 40): Array<{ at: string; kind: string; detail: string }> {
    const rows = this.db
      .prepare('SELECT at, kind, detail FROM ingest_log ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ at: string; kind: string; detail: string }>;
    return rows;
  }

  clearSources(): void {
    this.db.exec('DELETE FROM source_files');
  }

  /** Drop one provider so a reader change can rebuild it without rereading the others. */
  dropProvider(provider: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM commit_links WHERE session_id IN (SELECT id FROM sessions WHERE provider = ?)',
        )
        .run(provider);
      this.db
        .prepare(
          'DELETE FROM file_touches WHERE session_id IN (SELECT id FROM sessions WHERE provider = ?)',
        )
        .run(provider);
      this.db
        .prepare(
          'DELETE FROM turns WHERE session_id IN (SELECT id FROM sessions WHERE provider = ?)',
        )
        .run(provider);
      this.db.prepare('DELETE FROM sessions WHERE provider = ?').run(provider);
      this.db.prepare('DELETE FROM source_files WHERE provider = ?').run(provider);
    });
  }

  sourceCursor(path: string): { size: number; mtimeMs: number; offset: number } | null {
    const row = this.db
      .prepare('SELECT size, mtime_ms, parsed_offset FROM source_files WHERE path = ?')
      .get(path) as { size: number; mtime_ms: number; parsed_offset: number } | undefined;
    if (row === undefined) return null;
    return { size: row.size, mtimeMs: row.mtime_ms, offset: row.parsed_offset };
  }

  sourceFresh(path: string, size: number, mtimeMs: number): boolean {
    const cursor = this.sourceCursor(path);
    if (cursor === null) return false;
    return cursor.size === size && cursor.mtimeMs === mtimeMs;
  }

  markSource(
    path: string,
    provider: string,
    size: number,
    mtimeMs: number,
    sessionId: string,
    offset: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO source_files (path, provider, size, mtime_ms, session_id, parsed_offset)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           size = excluded.size, mtime_ms = excluded.mtime_ms, session_id = excluded.session_id,
           parsed_offset = excluded.parsed_offset`,
      )
      .run(path, provider, size, mtimeMs, sessionId, offset);
  }

  upsertSession(session: Session, repoId: string | null): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (
            id, provider, external_id, source_path, cwd, cwd_uncertain, branch, branches_json,
            started_at, ended_at, first_edit_at, last_edit_at, partial, tokens_known, title,
            input_tokens, cached_tokens, output_tokens, cost_usd, models_json, user_messages,
            assistant_messages, tool_calls, repo_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            cwd = excluded.cwd, cwd_uncertain = excluded.cwd_uncertain, branch = excluded.branch,
            branches_json = excluded.branches_json, started_at = excluded.started_at, ended_at = excluded.ended_at,
            first_edit_at = excluded.first_edit_at, last_edit_at = excluded.last_edit_at, partial = excluded.partial,
            tokens_known = excluded.tokens_known, title = excluded.title, input_tokens = excluded.input_tokens,
            cached_tokens = excluded.cached_tokens, output_tokens = excluded.output_tokens, cost_usd = excluded.cost_usd,
            models_json = excluded.models_json, user_messages = excluded.user_messages,
            assistant_messages = excluded.assistant_messages, tool_calls = excluded.tool_calls,
            source_path = excluded.source_path, repo_id = COALESCE(excluded.repo_id, sessions.repo_id)`,
        )
        .run(
          session.id,
          session.provider,
          session.externalId,
          session.sourcePath,
          session.cwd,
          session.cwdUncertain ? 1 : 0,
          session.branch,
          JSON.stringify(session.branches),
          session.startedAt,
          session.endedAt,
          session.firstEditAt,
          session.lastEditAt,
          session.partial ? 1 : 0,
          session.tokensKnown ? 1 : 0,
          session.title,
          session.inputTokens,
          session.cachedInputTokens,
          session.outputTokens,
          session.costUSD,
          JSON.stringify(session.models),
          session.userMessages,
          session.assistantMessages,
          session.toolCalls,
          repoId,
        );
      this.db.prepare('DELETE FROM turns WHERE session_id = ?').run(session.id);
      this.db.prepare('DELETE FROM file_touches WHERE session_id = ?').run(session.id);
      const turn = this.db.prepare(
        `INSERT INTO turns (
           session_id, idx, started_at, ended_at, role, model, input_tokens, output_tokens, cost_usd, tool_calls, sidechain
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of session.turns) {
        turn.run(
          session.id,
          item.index,
          item.startedAt,
          item.endedAt,
          item.role,
          item.model,
          item.inputTokens,
          item.outputTokens,
          item.costUSD,
          item.toolCalls,
          item.sidechain ? 1 : 0,
        );
      }
      const touch = this.db.prepare(
        'INSERT INTO file_touches (session_id, turn_index, path, kind, at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const item of session.fileTouches) {
        touch.run(session.id, item.turnIndex, item.path, item.kind, item.at);
      }
    });
  }

  unratedSessionCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM sessions WHERE rating IS NULL')
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  listSessions(): SessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (
           SELECT COUNT(*) FROM commit_links l WHERE l.session_id = s.id AND l.rejected = 0
         ) AS linked_commits
         FROM sessions s ORDER BY s.started_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => sessionRow(row));
  }

  getSession(id: string): SessionDetail | null {
    const row = this.db
      .prepare(
        `SELECT s.*, (
         SELECT COUNT(*) FROM commit_links l WHERE l.session_id = s.id AND l.rejected = 0
       ) AS linked_commits FROM sessions s WHERE s.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const turns = this.db
      .prepare(
        'SELECT idx, role, started_at, model, tool_calls, sidechain FROM turns WHERE session_id = ? ORDER BY idx LIMIT 80',
      )
      .all(id) as Array<Record<string, unknown>>;
    const files = this.db
      .prepare(
        'SELECT path, kind FROM file_touches WHERE session_id = ? GROUP BY path, kind ORDER BY MIN(id) LIMIT 24',
      )
      .all(id) as Array<{ path: string; kind: string }>;
    const links = this.db
      .prepare(
        `SELECT c.sha, c.subject, l.score, l.confidence, l.explanation_json, l.decided_by
         FROM commit_links l JOIN commits c ON c.id = l.commit_id
         WHERE l.session_id = ? AND l.rejected = 0 ORDER BY l.score DESC`,
      )
      .all(id) as Array<Record<string, unknown>>;
    return {
      ...sessionRow(row),
      branches: parseStringArray(row.branches_json),
      turns: turns.map((turn) => ({
        index: numberOf(turn.idx),
        role: String(turn.role),
        startedAt: stringOrNull(turn.started_at),
        model: stringOrNull(turn.model),
        toolCalls: numberOf(turn.tool_calls),
        sidechain: numberOf(turn.sidechain) === 1,
      })),
      files,
      links: links.map((link) => ({
        sha: String(link.sha),
        subject: String(link.subject),
        score: numberOf(link.score),
        confidence: String(link.confidence),
        explanation: explain(link.explanation_json),
        decidedBy: String(link.decided_by),
      })),
    };
  }

  rateSession(id: string, rating: SessionRating, note: string | null): void {
    this.db
      .prepare('UPDATE sessions SET rating = ?, rating_note = ?, rated_at = ? WHERE id = ?')
      .run(rating, note, new Date().toISOString(), id);
  }

  sessionsForLinking(): Session[] {
    const rows = this.db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>;
    const grouped = new Map<string, Session['fileTouches']>();
    const touches = this.db
      .prepare(
        `SELECT session_id, path, kind, at, turn_index FROM file_touches WHERE kind != 'read'`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const touch of touches) {
      const id = String(touch.session_id);
      const item = {
        path: String(touch.path),
        kind: touchKind(touch.kind),
        at: stringOrNull(touch.at),
        turnIndex: numberOf(touch.turn_index),
      };
      const list = grouped.get(id);
      if (list === undefined) grouped.set(id, [item]);
      else list.push(item);
    }
    return rows.map((row) => this.sessionForLink(row, grouped.get(String(row.id)) ?? []));
  }

  upsertRepo(rootPath: string, name: string, remoteUrl: string | null): string {
    const id = rootPath;
    this.db
      .prepare(
        `INSERT INTO repos (id, root_path, name, remote_url, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(root_path) DO UPDATE SET name = excluded.name, remote_url = excluded.remote_url, last_seen = excluded.last_seen`,
      )
      .run(id, rootPath, name, remoteUrl, new Date().toISOString());
    return id;
  }

  listRepos(): RepoRow[] {
    const rows = this.db.prepare('SELECT * FROM repos ORDER BY name').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: String(row.id),
      rootPath: String(row.root_path),
      name: String(row.name),
      remoteUrl: stringOrNull(row.remote_url),
      enabled: numberOf(row.enabled) === 1,
      testGlobs: parseStringArray(row.test_globs_json),
      lastSeen: stringOrNull(row.last_seen),
      gitOk: numberOf(row.git_ok) === 1,
      gitDetail: stringOrNull(row.git_detail),
      importedAt: stringOrNull(row.imported_at),
    }));
  }

  recordRepoGit(id: string, ok: boolean, detail: string | null): void {
    this.db
      .prepare(
        `UPDATE repos SET git_ok = ?, git_detail = ?, imported_at = CASE WHEN ? = 1 THEN ? ELSE imported_at END
         WHERE id = ?`,
      )
      .run(ok ? 1 : 0, detail, ok ? 1 : 0, new Date().toISOString(), id);
  }

  updateRepo(id: string, enabled: boolean, testGlobs: string[]): void {
    this.db
      .prepare('UPDATE repos SET enabled = ?, test_globs_json = ? WHERE id = ?')
      .run(enabled ? 1 : 0, JSON.stringify(testGlobs), id);
  }

  latestCommitTime(repoId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(COALESCE(commit_time, author_time)) AS commit_time
         FROM commits WHERE repo_id = ? AND unreachable = 0`,
      )
      .get(repoId) as { commit_time: string | null } | undefined;
    const value = row?.commit_time;
    if (typeof value !== 'string' || value === '') return null;
    return value;
  }

  earliestSessionStart(repoId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT MIN(started_at) AS started_at FROM sessions WHERE repo_id = ? AND started_at IS NOT NULL',
      )
      .get(repoId) as { started_at: string | null } | undefined;
    const value = row?.started_at;
    if (typeof value !== 'string' || value === '') return null;
    return value;
  }

  replaceCommits(
    repoId: string,
    commits: ParsedCommit[],
    testFiles: (path: string) => boolean,
    since: string,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO commits (
         repo_id, sha, author_time, commit_time, author_email, parent_shas_json, body, subject, files_json,
         insertions, deletions, test_files, test_lines, is_merge, is_revert, revert_of, unreachable
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(repo_id, sha) DO UPDATE SET
         author_time = excluded.author_time, commit_time = excluded.commit_time,
         author_email = excluded.author_email, parent_shas_json = excluded.parent_shas_json,
         body = excluded.body, subject = excluded.subject, files_json = excluded.files_json,
         insertions = excluded.insertions, deletions = excluded.deletions,
         test_files = excluded.test_files, test_lines = excluded.test_lines,
         is_merge = excluded.is_merge, is_revert = excluded.is_revert, revert_of = excluded.revert_of, unreachable = 0`,
    );
    this.transaction(() => {
      this.db
        .prepare(
          'UPDATE commits SET unreachable = 1 WHERE repo_id = ? AND COALESCE(commit_time, author_time) >= ?',
        )
        .run(repoId, since);
      for (const commit of commits) {
        const insertions = commit.files.reduce((sum, file) => sum + file.insertions, 0);
        const deletions = commit.files.reduce((sum, file) => sum + file.deletions, 0);
        const testFileList = commit.files.filter((file) => testFiles(file.path));
        const tests = testFileList.length;
        const testLines = testFileList.reduce(
          (sum, file) => sum + file.insertions + file.deletions,
          0,
        );
        insert.run(
          repoId,
          commit.sha,
          commit.authorTime,
          commit.commitTime,
          commit.authorEmail,
          JSON.stringify(commit.parents),
          commit.body,
          commit.subject,
          JSON.stringify(
            commit.files.map((file) => ({
              path: file.path,
              insertions: file.insertions,
              deletions: file.deletions,
            })),
          ),
          insertions,
          deletions,
          tests,
          testLines,
          commit.isMerge ? 1 : 0,
          commit.isRevert ? 1 : 0,
          commit.revertOf,
        );
      }
    });
  }

  commitsForRepo(repoId: string): CommitRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, EXISTS(
           SELECT 1 FROM commit_links l WHERE l.commit_id = c.id AND l.rejected = 0
         ) AS linked
         FROM commits c WHERE c.repo_id = ? AND c.unreachable = 0 ORDER BY c.author_time DESC`,
      )
      .all(repoId) as Array<Record<string, unknown>>;
    return rows.map((row) => commitRow(row));
  }

  linksForCommit(commitId: number): Array<{
    sessionId: string;
    title: string | null;
    score: number;
    confidence: string;
    explanation: string;
    decidedBy: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT l.session_id, l.score, l.confidence, l.explanation_json, l.decided_by, s.title
         FROM commit_links l
         LEFT JOIN sessions s ON s.id = l.session_id
         WHERE l.commit_id = ? AND l.rejected = 0
         ORDER BY l.score DESC`,
      )
      .all(commitId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      title: stringOrNull(row.title),
      score: numberOf(row.score),
      confidence: String(row.confidence),
      explanation: explain(row.explanation_json),
      decidedBy: String(row.decided_by),
    }));
  }

  listCommits(): CommitRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, EXISTS(
           SELECT 1 FROM commit_links l WHERE l.commit_id = c.id AND l.rejected = 0
         ) AS linked,
         (
           SELECT l.session_id FROM commit_links l
           WHERE l.commit_id = c.id AND l.rejected = 0
           ORDER BY l.score DESC LIMIT 1
         ) AS session_id,
         (
           SELECT l.score FROM commit_links l
           WHERE l.commit_id = c.id AND l.rejected = 0
           ORDER BY l.score DESC LIMIT 1
         ) AS link_score
         FROM commits c ORDER BY c.author_time DESC LIMIT 400`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => commitRow(row));
  }

  commitPaths(commitId: number): string[] {
    return this.commitFiles(commitId).map((file) => file.path);
  }

  commitFiles(
    commitId: number,
  ): Array<{ path: string; insertions: number | null; deletions: number | null }> {
    const row = this.db.prepare('SELECT files_json FROM commits WHERE id = ?').get(commitId) as
      | { files_json: string }
      | undefined;
    return row === undefined ? [] : parseCommitFiles(row.files_json);
  }

  setChurn(
    commitId: number,
    churn7: number | null,
    churn30: number | null,
    head: string,
    note: string,
  ): void {
    this.db
      .prepare(
        'UPDATE commits SET churn7 = ?, churn30 = ?, churn_head = ?, churn_note = ? WHERE id = ?',
      )
      .run(churn7, churn30, head, note, commitId);
  }

  replaceAutoLinks(repoId: string, links: Array<CommitLink & { commitId: number }>): void {
    this.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM commit_links WHERE decided_by = 'auto' AND commit_id IN (SELECT id FROM commits WHERE repo_id = ?)`,
        )
        .run(repoId);
      const insert = this.db.prepare(
        `INSERT INTO commit_links (commit_id, session_id, score, confidence, explanation_json, decided_by, rejected, share)
         VALUES (?, ?, ?, ?, ?, 'auto', 0, ?)
         ON CONFLICT(commit_id, session_id) DO UPDATE SET
           score = excluded.score, confidence = excluded.confidence, explanation_json = excluded.explanation_json,
           share = excluded.share
         WHERE commit_links.decided_by = 'auto'`,
      );
      for (const link of links) {
        const blocked = this.db
          .prepare(
            'SELECT rejected, decided_by FROM commit_links WHERE commit_id = ? AND session_id = ?',
          )
          .get(link.commitId, link.sessionId) as
          | { rejected: number; decided_by: string }
          | undefined;
        if (blocked !== undefined && (blocked.rejected === 1 || blocked.decided_by === 'user'))
          continue;
        insert.run(
          link.commitId,
          link.sessionId,
          link.score,
          link.confidence,
          JSON.stringify(link.signals),
          link.share,
        );
      }
    });
  }

  decideLink(commitId: number, sessionId: string, decision: 'confirm' | 'reject' | 'link'): void {
    switch (decision) {
      case 'reject': {
        this.db
          .prepare(
            `INSERT INTO commit_links (commit_id, session_id, score, confidence, explanation_json, decided_by, rejected, share)
             VALUES (?, ?, 0, 'low', '[]', 'user', 1, 0)
             ON CONFLICT(commit_id, session_id) DO UPDATE SET rejected = 1, decided_by = 'user'`,
          )
          .run(commitId, sessionId);
        return;
      }
      case 'confirm': {
        this.writeUserLink(commitId, sessionId, 'You confirmed this link.');
        return;
      }
      case 'link': {
        this.writeUserLink(commitId, sessionId, 'You linked this session by hand.');
        return;
      }
      default: {
        const unexpected: never = decision;
        throw new Error(unexpected);
      }
    }
  }

  private writeUserLink(commitId: number, sessionId: string, detail: string): void {
    this.db
      .prepare(
        `INSERT INTO commit_links (commit_id, session_id, score, confidence, explanation_json, decided_by, rejected, share)
         VALUES (?, ?, 1, 'high', ?, 'user', 0, 1)
         ON CONFLICT(commit_id, session_id) DO UPDATE SET
           rejected = 0, decided_by = 'user', confidence = 'high', score = 1,
           explanation_json = excluded.explanation_json`,
      )
      .run(commitId, sessionId, JSON.stringify([{ name: 'text', weight: 1, score: 1, detail }]));
  }

  replaceUsage(rows: UsageDayRow[]): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM usage_days');
      const insert = this.db.prepare(
        'INSERT INTO usage_days (day, provider, input_tokens, output_tokens, cached_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const row of rows) {
        insert.run(
          row.day,
          row.provider,
          row.inputTokens,
          row.outputTokens,
          row.cachedTokens,
          row.costUsd,
        );
      }
    });
  }

  modelCosts(
    from: string | null,
    to: string | null,
  ): Array<{ model: string; costUsd: number; sessions: number }> {
    const rows = this.db
      .prepare('SELECT models_json, cost_usd, started_at FROM sessions WHERE tokens_known = 1')
      .all() as Array<{ models_json: string; cost_usd: number; started_at: string | null }>;
    const totals = new Map<string, { costUsd: number; sessions: number }>();
    for (const row of rows) {
      if (!sessionInDays(row.started_at, from, to)) continue;
      const models = parseStringArray(row.models_json);
      const name =
        models.length === 1 ? models[0] : models.length === 0 ? 'unknown' : 'several models';
      if (name === undefined) continue;
      const current = totals.get(name) ?? { costUsd: 0, sessions: 0 };
      current.costUsd += row.cost_usd;
      current.sessions += 1;
      totals.set(name, current);
    }
    return [...totals.entries()]
      .map(([model, value]) => ({ model, costUsd: value.costUsd, sessions: value.sessions }))
      .toSorted((left, right) => right.costUsd - left.costUsd);
  }

  usageDays(): UsageDayRow[] {
    const rows = this.db.prepare('SELECT * FROM usage_days ORDER BY day').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      day: String(row.day),
      provider: String(row.provider),
      inputTokens: numberOf(row.input_tokens),
      outputTokens: numberOf(row.output_tokens),
      cachedTokens: numberOf(row.cached_tokens),
      costUsd: numberOf(row.cost_usd),
    }));
  }

  snapshotCursorCommit(commit: CursorCommitAttribution): boolean {
    const existing = this.db
      .prepare(
        `SELECT repo_name, branch, ai_percentage, composer_added, composer_deleted, tab_added, tab_deleted
         FROM cursor_commits WHERE sha = ?`,
      )
      .get(commit.commitHash) as
      | {
          repo_name: string | null;
          branch: string | null;
          ai_percentage: number | null;
          composer_added: number;
          composer_deleted: number;
          tab_added: number;
          tab_deleted: number;
        }
      | undefined;
    if (
      existing !== undefined &&
      existing.repo_name === commit.repoName &&
      existing.branch === commit.branchName &&
      existing.ai_percentage === commit.aiPercentage &&
      existing.composer_added === commit.composerLinesAdded &&
      existing.composer_deleted === commit.composerLinesDeleted &&
      existing.tab_added === commit.tabLinesAdded &&
      existing.tab_deleted === commit.tabLinesDeleted
    ) {
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO cursor_commits (
           sha, repo_name, branch, ai_percentage, composer_added, composer_deleted, tab_added, tab_deleted, seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha) DO UPDATE SET
           repo_name = excluded.repo_name, branch = excluded.branch, ai_percentage = excluded.ai_percentage,
           composer_added = excluded.composer_added, composer_deleted = excluded.composer_deleted,
           tab_added = excluded.tab_added, tab_deleted = excluded.tab_deleted, seen_at = excluded.seen_at`,
      )
      .run(
        commit.commitHash,
        commit.repoName,
        commit.branchName,
        commit.aiPercentage,
        commit.composerLinesAdded,
        commit.composerLinesDeleted,
        commit.tabLinesAdded,
        commit.tabLinesDeleted,
        new Date().toISOString(),
      );
    return true;
  }

  cursorCommitPercentages(): Map<string, number | null> {
    const rows = this.db.prepare('SELECT sha, ai_percentage FROM cursor_commits').all() as Array<{
      sha: string;
      ai_percentage: number | null;
    }>;
    return new Map(rows.map((row) => [row.sha, row.ai_percentage]));
  }

  replaceCursorDaily(
    rows: Array<{
      day: string;
      tabSuggested: number;
      tabAccepted: number;
      composerSuggested: number;
      composerAccepted: number;
    }>,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO cursor_daily (day, tab_suggested, tab_accepted, composer_suggested, composer_accepted)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         tab_suggested = excluded.tab_suggested, tab_accepted = excluded.tab_accepted,
         composer_suggested = excluded.composer_suggested, composer_accepted = excluded.composer_accepted`,
    );
    for (const row of rows) {
      insert.run(
        row.day,
        row.tabSuggested,
        row.tabAccepted,
        row.composerSuggested,
        row.composerAccepted,
      );
    }
  }

  cursorAcceptance(): { suggested: number; accepted: number } {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(tab_suggested), 0) AS suggested, COALESCE(SUM(tab_accepted), 0) AS accepted FROM cursor_daily',
      )
      .get() as { suggested: number; accepted: number };
    return { suggested: row.suggested, accepted: row.accepted };
  }

  setting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    if (row === undefined) return fallback;
    return JSON.parse(row.value_json) as T;
  }

  replaceDailyMetrics(
    day: string,
    rows: ReadonlyArray<{
      repoId: string;
      provider: string;
      metric: string;
      value: number | null;
      inputs: unknown;
    }>,
  ): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM metric_daily WHERE day = ?').run(day);
      const insert = this.db.prepare(
        `INSERT INTO metric_daily (day, repo_id, provider, metric, value, inputs_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(
          day,
          row.repoId,
          row.provider,
          row.metric,
          row.value,
          JSON.stringify(row.inputs),
        );
      }
    });
  }

  dailyMetrics(day: string): Array<{ metric: string; value: number | null; inputs: string }> {
    const rows = this.db
      .prepare('SELECT metric, value, inputs_json FROM metric_daily WHERE day = ? ORDER BY metric')
      .all(day) as Array<{ metric: string; value: number | null; inputs_json: string }>;
    return rows.map((row) => ({
      metric: row.metric,
      value: row.value,
      inputs: row.inputs_json,
    }));
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, JSON.stringify(value));
  }

  metricInputs(): {
    sessions: Array<{
      id: string;
      provider: 'claude' | 'codex' | 'cursor';
      repoId: string | null;
      startedAt: string | null;
      endedAt: string | null;
      firstEditAt: string | null;
      turnTimestamps: string[];
      turns: number;
      costUsd: number;
      rating: SessionRating | null;
    }>;
    commits: Array<{
      id: string;
      repoId: string;
      sha: string;
      authorTime: string;
      insertions: number;
      deletions: number;
      testFilesChanged: number;
      testLines: number;
      isRevert: boolean;
      churn7: number | null;
      churn30: number | null;
    }>;
    links: Array<{
      sessionId: string;
      commitId: string;
      confidence: 'high' | 'medium' | 'low';
      decidedBy: 'auto' | 'user';
      rejected: boolean;
    }>;
  } {
    const sessions = (
      this.db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>
    ).map((row) => ({
      id: String(row.id),
      provider: String(row.provider) as 'claude' | 'codex' | 'cursor',
      repoId: stringOrNull(row.repo_id),
      startedAt: stringOrNull(row.started_at),
      endedAt: stringOrNull(row.ended_at),
      firstEditAt: stringOrNull(row.first_edit_at),
      turnTimestamps: (
        this.db
          .prepare('SELECT started_at FROM turns WHERE session_id = ? AND started_at IS NOT NULL')
          .all(String(row.id)) as Array<{ started_at: string }>
      ).map((turn) => turn.started_at),
      turns: numberOf(row.assistant_messages),
      costUsd: numberOf(row.cost_usd),
      rating: stringOrNull(row.rating) as SessionRating | null,
    }));
    const commits = (
      this.db.prepare('SELECT * FROM commits WHERE unreachable = 0').all() as Array<
        Record<string, unknown>
      >
    ).map((row) => ({
      id: String(row.id),
      repoId: String(row.repo_id),
      sha: String(row.sha),
      authorTime: String(row.author_time),
      insertions: numberOf(row.insertions),
      deletions: numberOf(row.deletions),
      testFilesChanged: numberOf(row.test_files),
      testLines: numberOf(row.test_lines),
      isRevert: numberOf(row.is_revert) === 1,
      churn7: row.churn7 === null ? null : numberOf(row.churn7),
      churn30: row.churn30 === null ? null : numberOf(row.churn30),
    }));
    const links = (
      this.db.prepare('SELECT * FROM commit_links').all() as Array<Record<string, unknown>>
    ).map((row) => ({
      sessionId: String(row.session_id),
      commitId: String(row.commit_id),
      confidence: String(row.confidence) as 'high' | 'medium' | 'low',
      decidedBy: String(row.decided_by) as 'auto' | 'user',
      rejected: numberOf(row.rejected) === 1,
    }));
    return { sessions, commits, links };
  }

  private sessionForLink(
    row: Record<string, unknown>,
    fileTouches: Session['fileTouches'],
  ): Session {
    return {
      id: String(row.id),
      provider: String(row.provider) as Session['provider'],
      externalId: String(row.external_id),
      sourcePath: String(row.source_path),
      cwd: stringOrNull(row.cwd),
      cwdUncertain: numberOf(row.cwd_uncertain) === 1,
      branch: stringOrNull(row.branch),
      branches: parseStringArray(row.branches_json),
      startedAt: stringOrNull(row.started_at),
      endedAt: stringOrNull(row.ended_at),
      firstEditAt: stringOrNull(row.first_edit_at),
      lastEditAt: stringOrNull(row.last_edit_at),
      partial: numberOf(row.partial) === 1,
      tokensKnown: numberOf(row.tokens_known) === 1,
      title: stringOrNull(row.title),
      turns: [],
      fileTouches,
      inputTokens: numberOf(row.input_tokens),
      cachedInputTokens: numberOf(row.cached_tokens),
      outputTokens: numberOf(row.output_tokens),
      costUSD: numberOf(row.cost_usd),
      models: parseStringArray(row.models_json),
      userMessages: numberOf(row.user_messages),
      assistantMessages: numberOf(row.assistant_messages),
      toolCalls: numberOf(row.tool_calls),
    };
  }

  private transaction(body: () => void): void {
    this.db.exec('BEGIN');
    try {
      body();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function touchKind(value: unknown): FileTouchKind {
  if (value === 'read' || value === 'edit' || value === 'create' || value === 'delete')
    return value;
  return 'edit';
}

function sessionRow(row: Record<string, unknown>): SessionRow {
  return {
    id: String(row.id),
    provider: String(row.provider) as SessionRow['provider'],
    title: stringOrNull(row.title),
    cwd: stringOrNull(row.cwd),
    branch: stringOrNull(row.branch),
    startedAt: stringOrNull(row.started_at),
    endedAt: stringOrNull(row.ended_at),
    firstEditAt: stringOrNull(row.first_edit_at),
    costUsd: numberOf(row.cost_usd),
    inputTokens: numberOf(row.input_tokens),
    outputTokens: numberOf(row.output_tokens),
    tokensKnown: numberOf(row.tokens_known) === 1,
    rating: stringOrNull(row.rating) as SessionRating | null,
    ratingNote: stringOrNull(row.rating_note),
    linkedCommits: numberOf(row.linked_commits),
    repoId: stringOrNull(row.repo_id),
    toolCalls: numberOf(row.tool_calls),
    userMessages: numberOf(row.user_messages),
    assistantMessages: numberOf(row.assistant_messages),
  };
}

function commitRow(row: Record<string, unknown>): CommitRow {
  return {
    id: numberOf(row.id),
    repoId: String(row.repo_id),
    sha: String(row.sha),
    authorTime: String(row.author_time),
    commitTime: stringOrNull(row.commit_time),
    authorEmail: stringOrNull(row.author_email),
    parents: parseStringArray(row.parent_shas_json),
    body: typeof row.body === 'string' ? row.body : '',
    subject: String(row.subject),
    insertions: numberOf(row.insertions),
    deletions: numberOf(row.deletions),
    testFiles: numberOf(row.test_files),
    testLines: numberOf(row.test_lines),
    isRevert: numberOf(row.is_revert) === 1,
    revertOf: stringOrNull(row.revert_of),
    churn7: row.churn7 === null || row.churn7 === undefined ? null : numberOf(row.churn7),
    churn30: row.churn30 === null || row.churn30 === undefined ? null : numberOf(row.churn30),
    churnHead: stringOrNull(row.churn_head),
    churnNote: stringOrNull(row.churn_note),
    linked: numberOf(row.linked) === 1,
    sessionId: stringOrNull(row.session_id),
    linkScore:
      row.link_score === null || row.link_score === undefined ? null : numberOf(row.link_score),
    unreachable: numberOf(row.unreachable) === 1,
  };
}

function explain(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return value;
    const details: string[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) continue;
      const detail = item.detail;
      if (typeof detail === 'string' && detail !== '') details.push(detail);
    }
    return details
      .map((detail, index) => {
        if (index === details.length - 1 || /[.!?]$/u.test(detail)) return detail;
        return `${detail}.`;
      })
      .join(' ');
  } catch {
    return value;
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function parseCommitFiles(
  value: string,
): Array<{ path: string; insertions: number | null; deletions: number | null }> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const files: Array<{ path: string; insertions: number | null; deletions: number | null }> = [];
    for (const item of parsed) {
      if (typeof item === 'string') {
        files.push({ path: item, insertions: null, deletions: null });
        continue;
      }
      if (!isRecord(item) || typeof item.path !== 'string') continue;
      files.push({
        path: item.path,
        insertions: typeof item.insertions === 'number' ? item.insertions : null,
        deletions: typeof item.deletions === 'number' ? item.deletions : null,
      });
    }
    return files;
  } catch {
    return [];
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sessionInDays(startedAt: string | null, from: string | null, to: string | null): boolean {
  if (from === null && to === null) return true;
  if (startedAt === null) return false;
  const parsed = new Date(startedAt);
  if (Number.isNaN(parsed.getTime())) return false;
  const day = localDay(parsed);
  if (from !== null && day < from) return false;
  if (to !== null && day > to) return false;
  return true;
}
