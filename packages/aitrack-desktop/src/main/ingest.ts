import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setImmediate } from 'node:timers';

import { mergeDayMaps } from 'aitrack-lib/data/dayMap';
import type { DayMap } from 'aitrack-lib/data/types';
import { openParseCache, type CachedParse } from 'aitrack-lib/readers/cache';
import { getClaudePaths, mergeClaudeParsed, parseClaudeFile } from 'aitrack-lib/readers/claude';
import { getCodexPaths, parseCodexFile } from 'aitrack-lib/readers/codex';
import { readCursorData } from 'aitrack-lib/readers/cursor/index';
import { getCursorStateDatabasePath } from 'aitrack-lib/readers/cursor/location';
import { listUniqueSourceFiles } from 'aitrack-lib/readers/paths';
import {
  buildLeverageReport,
  isTestPath,
  linkSession,
  measureBlame,
  readCommitLog,
  readCommitsOnBranches,
  readRemoteUrl,
  readRepoRoot,
  isCursorSubagentTranscript,
  readCursorTracking,
  runAllowedGit,
} from 'aitrack-lib/sessions/index';
import type { CommitLink, Session, SessionSignals } from 'aitrack-lib/sessions/index';

import { localDay } from './budget.js';
import type { DesktopStore, UsageDayRow } from './store.js';
import { completeLineOffset, tailHasCompleteLine } from './transcriptOffset.js';
import { ReaderPool, type FileUsage, type ReaderProvider } from './workerPool.js';

export const INGEST_VERSION = desktopVersion();

export interface IngestSummary {
  sessions: number;
  repos: number;
  commits: number;
  links: number;
}

const CHURN_CAP = 12;

/** A stored churn result is reused until HEAD moves. */
export function churnIsCurrent(
  commit: { churn7: number | null; churnNote: string | null; churnHead: string | null },
  head: string,
): boolean {
  return commit.churnHead === head && (commit.churn7 !== null || commit.churnNote !== null);
}

/**
 * Read local transcripts, import commits read-only, and store links.
 * Safe to run again: unchanged files are skipped, user link decisions are kept.
 */
export interface ProviderFlags {
  claude: boolean;
  codex: boolean;
  cursor: boolean;
}

export function enabledProviders(store: DesktopStore): ProviderFlags {
  return {
    claude: store.setting<boolean>('claude', true),
    codex: store.setting<boolean>('codex', true),
    cursor: store.setting<boolean>('cursor', true),
  };
}

const CURSOR_CACHE_SECONDS = 6 * 60 * 60;
const CURSOR_SHAPE = 'chat';

type IngestOptions = Partial<ProviderFlags> & { refreshCursor?: boolean; full?: boolean };

let ingestGate: Promise<IngestSummary> | null = null;
let ingestNext: Promise<IngestSummary> | null = null;
let ingestNextJob: { store: DesktopStore; options?: IngestOptions } | null = null;

export function ingestAll(store: DesktopStore, options?: IngestOptions): Promise<IngestSummary> {
  if (ingestGate !== null) {
    ingestNextJob = { store, options };
    ingestNext ??= ingestGate.then(() => {
      ingestNext = null;
      const job = ingestNextJob;
      ingestNextJob = null;
      if (job === null) return { sessions: 0, repos: 0, commits: 0, links: 0 };
      return ingestAll(job.store, job.options);
    });
    return ingestNext;
  }
  const run = runIngest(store, options).finally(() => {
    ingestGate = null;
  });
  ingestGate = run;
  return run;
}

async function runIngest(store: DesktopStore, options?: IngestOptions): Promise<IngestSummary> {
  const claude = options?.claude ?? true;
  const codex = options?.codex ?? true;
  const cursor = options?.cursor ?? true;
  const refreshCursor = options?.refreshCursor ?? false;
  const full =
    options?.full === true || store.setting<string>('ingestVersion', '') !== INGEST_VERSION;
  let sessions = 0;
  const pending: Array<{ session: Session; signals: SessionSignals }> = [];
  const pool = claude || codex || cursor ? new ReaderPool() : null;
  const claudeUsage = new Map<string, FileUsage>();
  const codexUsage = new Map<string, FileUsage>();
  try {
    if (full) store.clearSources();
    if (claude && pool !== null) {
      sessions += await readProvider(
        store,
        'claude',
        await listUniqueSourceFiles(getClaudePaths()),
        pending,
        pool,
        claudeUsage,
      );
    }
    if (codex && pool !== null) {
      sessions += await readProvider(
        store,
        'codex',
        await listUniqueSourceFiles(getCodexPaths()),
        pending,
        pool,
        codexUsage,
      );
    }

    if (cursor && store.setting<string>('cursorShape', '') !== CURSOR_SHAPE) {
      store.dropProvider('cursor');
    }
    const cursorRoots = cursor ? cursorProjectRoots() : [];
    if (cursorRoots.length > 0 && pool !== null) {
      const listed = await listUniqueSourceFiles(cursorRoots);
      const files = listed.filter((file) => !isCursorSubagentTranscript(file));
      sessions += await readProvider(store, 'cursor', files, pending, pool);
    }
    if (cursor) store.setSetting('cursorShape', CURSOR_SHAPE);

    if (cursor) await readCursorState(store);

    const repos = await discoverRepos(store, pending);
    let commits = 0;
    for (const repo of repos) {
      commits += await importRepo(store, repo.id, repo.root, full);
    }
    const links = await linkAll(store, repos, pending);
    await measureSomeChurn(store, repos);
    await refreshUsage(store, { claude, codex, cursor }, refreshCursor, claudeUsage, codexUsage);
    storeDailyMetrics(store);
    store.log(
      'ingest',
      `${String(sessions)} sessions, ${String(repos.length)} repos, ${String(links)} links`,
    );
    store.setSetting('ingestVersion', INGEST_VERSION);
    return { sessions, repos: repos.length, commits, links };
  } finally {
    await pool?.close();
  }
}

async function readProvider(
  store: DesktopStore,
  provider: ReaderProvider,
  files: string[],
  pending: Array<{ session: Session; signals: SessionSignals }>,
  pool: ReaderPool,
  usageOut?: Map<string, FileUsage>,
): Promise<number> {
  let count = 0;
  for (const file of files) {
    try {
      const info = await stat(file);
      const cursor = store.sourceCursor(file);
      const sameFile =
        cursor !== null && cursor.size === info.size && cursor.mtimeMs === info.mtimeMs;
      let subagentChanged = false;
      if (cursor !== null && sameFile && provider === 'cursor') {
        subagentChanged = await subagentsNewer(file, cursor.mtimeMs);
      }
      if (sameFile && !subagentChanged) continue;
      const offset = cursor === null || cursor.offset > info.size ? 0 : cursor.offset;
      // A half-written last line is read again on the next tick. The session parse
      // still starts at the beginning so token totals include every finished line.
      if (offset > 0 && !(await tailHasCompleteLine(file, offset))) continue;
      const result = await pool.read(provider, file);
      if (result.usage !== null && usageOut !== undefined) usageOut.set(file, result.usage);
      pending.push(result);
      store.upsertSession(result.session, null);
      const parsedOffset = await completeLineOffset(file);
      store.markSource(file, provider, info.size, info.mtimeMs, result.session.id, parsedOffset);
      count += 1;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unreadable transcript';
      store.log('read-error', `${file}: ${message}`);
    }
  }
  return count;
}

function desktopVersion(): string {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
    );
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'version' in raw &&
      typeof raw.version === 'string'
    ) {
      return raw.version;
    }
  } catch {
    return '0';
  }
  return '0';
}

function cursorProjectRoots(): string[] {
  const home = process.env.HOME;
  if (home === undefined || home === '') return [];
  return [`${home}/.cursor/projects`];
}

async function readCursorState(store: DesktopStore): Promise<void> {
  const database = getCursorStateDatabasePath();
  if (database === null) return;
  try {
    const tracking = await readCursorTracking(database);
    store.replaceCursorDaily(
      tracking.daily.map((day) => ({
        day: day.date,
        tabSuggested: day.tabSuggestedLines,
        tabAccepted: day.tabAcceptedLines,
        composerSuggested: day.composerSuggestedLines,
        composerAccepted: day.composerAcceptedLines,
      })),
    );
    if (tracking.recentCommit !== null && store.snapshotCursorCommit(tracking.recentCommit)) {
      store.log('cursor-commit', tracking.recentCommit.commitHash);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'cursor state unreadable';
    store.log('cursor-state', message);
  }
}

async function discoverRepos(
  store: DesktopStore,
  pending: Array<{ session: Session; signals: SessionSignals }>,
): Promise<Array<{ id: string; root: string }>> {
  const found = new Map<string, { id: string; root: string }>();
  for (const item of pending) {
    const cwd = item.session.cwd;
    if (cwd === null || item.session.cwdUncertain) continue;
    const root = await readRepoRoot(cwd);
    if (root === null) continue;
    const remote = await readRemoteUrl(root);
    const id = store.upsertRepo(root, basename(root), remote);
    store.upsertSession(item.session, id);
    found.set(id, { id, root });
  }
  for (const repo of store.listRepos()) {
    if (repo.enabled) found.set(repo.id, { id: repo.id, root: repo.rootPath });
  }
  return [...found.values()];
}

const DAY_MS = 86_400_000;

/** First import reaches back to the earliest session. Later imports cover the day before the newest commit. */
export function commitWindow(input: {
  full: boolean;
  latestCommit: string | null;
  earliestSession: string | null;
  now?: number;
}): string {
  const fallback = new Date((input.now ?? Date.now()) - 400 * DAY_MS).toISOString();
  if (!input.full && input.latestCommit !== null) {
    return shiftIso(input.latestCommit, DAY_MS) ?? fallback;
  }
  if (input.earliestSession !== null) {
    return shiftIso(input.earliestSession, 7 * DAY_MS) ?? fallback;
  }
  return fallback;
}

function shiftIso(iso: string, ms: number): string | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed - ms).toISOString();
}

async function importRepo(
  store: DesktopStore,
  repoId: string,
  root: string,
  full: boolean,
): Promise<number> {
  try {
    const since = commitWindow({
      full,
      latestCommit: store.latestCommitTime(repoId),
      earliestSession: store.earliestSessionStart(repoId),
    });
    const commits = await readCommitLog(root, since);
    const globs = store.listRepos().find((repo) => repo.id === repoId)?.testGlobs ?? [];
    store.replaceCommits(repoId, commits, (path) => isTestPath(path, globs), since);
    store.recordRepoGit(repoId, true, null);
    return commits.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'git log failed';
    store.recordRepoGit(repoId, false, message);
    store.log('git', `${root}: ${message}`);
    return 0;
  }
}

async function subagentsNewer(parentFile: string, sinceMs: number): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(join(dirname(parentFile), 'subagents'));
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const info = await stat(join(dirname(parentFile), 'subagents', name));
    if (info.mtimeMs > sinceMs) return true;
  }
  return false;
}

async function linkAll(
  store: DesktopStore,
  repos: Array<{ id: string; root: string }>,
  pending: Array<{ session: Session; signals: SessionSignals }>,
): Promise<number> {
  const sessions = store
    .sessionsForLinking()
    .filter((session) => session.cwd !== null && !session.cwdUncertain);
  const rootByCwd = new Map<string, string | null>();
  const byRoot = new Map<string, Session[]>();
  for (const session of sessions) {
    const cwd = session.cwd;
    if (cwd === null) continue;
    let top = rootByCwd.get(cwd);
    if (top === undefined) {
      top = await readRepoRoot(cwd);
      rootByCwd.set(cwd, top);
    }
    if (top === null) continue;
    const list = byRoot.get(top);
    if (list === undefined) byRoot.set(top, [session]);
    else list.push(session);
  }
  let links = 0;
  for (const repo of repos) {
    links += await linkRepo(store, repo.id, repo.root, pending, byRoot.get(repo.root) ?? []);
  }
  return links;
}

async function linkRepo(
  store: DesktopStore,
  repoId: string,
  root: string,
  pending: Array<{ session: Session; signals: SessionSignals }>,
  inRepo: Session[],
): Promise<number> {
  const commits = store.commitsForRepo(repoId);
  const branchNames = [...new Set(inRepo.flatMap((session) => session.branches))];
  let refs = new Map<string, string[]>();
  try {
    refs = await readCommitsOnBranches(root, branchNames);
  } catch (error) {
    store.log('git', error instanceof Error ? error.message : 'branch names unavailable');
  }
  const signalsById = new Map(pending.map((item) => [item.session.id, item.signals]));
  const cursor = store.cursorCommitPercentages();
  const linkable = commits.map((commit) => ({
    sha: commit.sha,
    authorTime: commit.authorTime,
    paths: store.commitPaths(commit.id),
    branches: refs.get(commit.sha) ?? [],
    subject: commit.subject,
    body: commit.body,
    cursorAiPercentage: cursor.get(commit.sha) ?? null,
  }));
  const links: Array<CommitLink & { commitId: number }> = [];
  for (const session of inRepo) {
    const scored = linkSession(
      session,
      signalsById.get(session.id) ?? { userExcerpt: '', assistantExcerpt: '' },
      linkable,
      {
        repoRoot: root,
        windowBeforeMs: store.setting<number>('linkBeforeMin', 5) * 60 * 1000,
        windowAfterMs: store.setting<number>('linkAfterHours', 6) * 60 * 60 * 1000,
      },
    );
    for (const link of scored) {
      const commit = commits.find((item) => item.sha === link.sha);
      if (commit === undefined) continue;
      links.push({ ...link, commitId: commit.id });
    }
  }
  store.replaceAutoLinks(repoId, links);
  return links.length;
}

async function measureSomeChurn(
  store: DesktopStore,
  repos: Array<{ id: string; root: string }>,
): Promise<void> {
  let measured = 0;
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const repo of repos) {
    if (measured >= CHURN_CAP) return;
    let head = '';
    try {
      const revision = await runAllowedGit(repo.root, ['rev-parse', 'HEAD']);
      head = revision.trim();
    } catch {
      continue;
    }
    for (const commit of store.commitsForRepo(repo.id)) {
      if (measured >= CHURN_CAP) return;
      if (churnIsCurrent(commit, head)) continue;
      if (Date.parse(commit.authorTime) > week) continue;
      const paths = store.commitPaths(commit.id);
      if (paths.length === 0 || paths.length > 6 || commit.insertions <= 0) continue;
      let surviving = 0;
      let skipReason: string | null = null;
      for (const path of paths) {
        const blame = await measureBlame(repo.root, commit.sha, path);
        if (blame.skipped) {
          skipReason = blame.reason ?? `${path} was skipped`;
          break;
        }
        surviving += blame.surviving;
      }
      const month = Date.now() - 30 * 24 * 60 * 60 * 1000;
      if (skipReason !== null) {
        store.setChurn(commit.id, null, null, head, skipReason);
        measured += 1;
        continue;
      }
      const ratio = Math.max(0, Math.min(1, 1 - surviving / commit.insertions));
      store.setChurn(
        commit.id,
        ratio,
        Date.parse(commit.authorTime) < month ? ratio : null,
        head,
        `${String(surviving)} of ${String(commit.insertions)} added lines still match this commit at ${head.slice(0, 7)}.`,
      );
      measured += 1;
    }
  }
}

async function refreshUsage(
  store: DesktopStore,
  flags: ProviderFlags,
  refreshCursor: boolean,
  claudeUsage: Map<string, FileUsage>,
  codexUsage: Map<string, FileUsage>,
): Promise<void> {
  const rows: UsageDayRow[] = [];
  if (flags.claude) {
    try {
      rows.push(...fold(await claudeDayMap(claudeUsage), 'claude_code'));
    } catch (error) {
      store.log('usage', error instanceof Error ? error.message : 'claude usage failed');
    }
  }
  if (flags.codex) {
    try {
      rows.push(...fold(await codexDayMap(codexUsage), 'codex'));
    } catch (error) {
      store.log('usage', error instanceof Error ? error.message : 'codex usage failed');
    }
  }
  if (flags.cursor) {
    try {
      rows.push(
        ...fold(
          await readCursorData({ maxAgeSeconds: refreshCursor ? 0 : CURSOR_CACHE_SECONDS }),
          'cursor',
        ),
      );
    } catch (error) {
      store.log('usage', error instanceof Error ? error.message : 'cursor usage failed');
    }
  }
  if (rows.length > 0) store.replaceUsage(rows);
}

function storeDailyMetrics(store: DesktopStore): void {
  const today = localDay(new Date());
  const report = buildLeverageReport({
    ...store.metricInputs(),
    window: { from: null, to: null },
    now: new Date().toISOString(),
  });
  store.replaceDailyMetrics(
    today,
    [...report.speed, ...report.quality, ...report.cost].map((item) => ({
      repoId: '',
      provider: '',
      metric: item.id,
      value: item.value,
      inputs: {
        rule: item.rule,
        caveat: item.caveat,
        sampleSize: item.sampleSize,
        ...item.inputs,
      },
    })),
  );
}

async function claudeDayMap(fresh: Map<string, FileUsage>): Promise<DayMap> {
  return cachedDayMap(
    'claude',
    await listUniqueSourceFiles(getClaudePaths()),
    fresh,
    (file) => parseClaudeFile(file),
    (parsed, files) => mergeClaudeParsed(parsed, files),
  );
}

async function codexDayMap(fresh: Map<string, FileUsage>): Promise<DayMap> {
  return cachedDayMap(
    'codex',
    await listUniqueSourceFiles(getCodexPaths()),
    fresh,
    (file) => parseCodexFile(file),
    (parsed) => {
      const days: DayMap = new Map();
      for (const entry of parsed) mergeDayMaps(days, entry.days);
      return days;
    },
  );
}

async function cachedDayMap(
  cacheName: string,
  files: string[],
  fresh: Map<string, FileUsage>,
  parseFile: (file: string) => Promise<CachedParse>,
  merge: (parsed: CachedParse[], files: string[]) => DayMap | Promise<DayMap>,
): Promise<DayMap> {
  const cache = openParseCache(cacheName);
  const parsed: CachedParse[] = [];
  for (const file of files) {
    const justRead = fresh.get(file);
    if (justRead !== undefined) {
      await cache.record(file, justRead);
      parsed.push(justRead);
      continue;
    }
    const cached = await cache.lookup(file);
    if (cached !== null) {
      parsed.push(cached);
      continue;
    }
    const fallback = await parseFile(file);
    await cache.record(file, fallback);
    parsed.push(fallback);
  }
  cache.save();
  return merge(parsed, files);
}

function fold(days: DayMap, provider: string): UsageDayRow[] {
  const rows: UsageDayRow[] = [];
  for (const [day, entry] of days) {
    rows.push({
      day,
      provider,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cachedTokens: entry.cachedInputTokens ?? 0,
      costUsd: entry.costUSD ?? 0,
    });
  }
  return rows;
}
