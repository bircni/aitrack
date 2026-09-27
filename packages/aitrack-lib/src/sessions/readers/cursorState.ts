import type { DatabaseSync } from 'node:sqlite';

import { isRecord, isFiniteNumber } from '../../data/guards.js';
import { readCursorDatabase } from '../../readers/cursor/authState.js';
import type { CursorCommitAttribution, CursorDailyStat } from '../types.js';

export interface CursorTracking {
  daily: CursorDailyStat[];
  recentCommit: CursorCommitAttribution | null;
}

export interface ComposerBounds {
  startedAt: string | null;
  endedAt: string | null;
}

const DAILY_KEY = /^aiCodeTracking\.dailyStats\..+\.(\d{4}-\d{2}-\d{2})$/u;

/**
 * Read Cursor's local AI-tracking rows.
 *
 * `dailyStats` is per day. `recentCommit` is a single "latest" key, so callers
 * snapshot it whenever it changes. Neither table is written.
 */
export function readCursorTracking(databasePath: string): Promise<CursorTracking> {
  return readCursorDatabase(databasePath, (database) => {
    const daily: CursorDailyStat[] = [];
    let recentCommit: CursorCommitAttribution | null = null;
    const rows = select(
      database,
      "SELECT key, value FROM ItemTable WHERE key LIKE 'aiCodeTracking.%'",
    );
    for (const row of rows) {
      const key = row.key;
      const parsed = parseJson(row.value);
      if (!isRecord(parsed)) continue;
      const date = DAILY_KEY.exec(key)?.[1];
      if (date !== undefined) {
        daily.push(dailyStat(date, parsed));
        continue;
      }
      if (key === 'aiCodeTracking.recentCommit') recentCommit = recentCommitOf(parsed);
    }
    return { daily, recentCommit };
  });
}

/** `createdAt` bounds for one composer, used when the transcript has no timestamps. */
export function readComposerBounds(
  databasePath: string,
  composerId: string,
): Promise<ComposerBounds> {
  return readCursorDatabase(databasePath, (database) => {
    const rows = select(
      database,
      'SELECT value FROM cursorDiskKV WHERE key = ?',
      `composerData:${composerId}`,
    );
    const parsed = parseJson(rows[0]?.value);
    if (!isRecord(parsed)) return { startedAt: null, endedAt: null };
    const headers = parsed.fullConversationHeadersOnly;
    if (!Array.isArray(headers)) return { startedAt: null, endedAt: null };
    const times = headers
      .map((header) =>
        isRecord(header) && typeof header.createdAt === 'string' ? header.createdAt : null,
      )
      .filter((value): value is string => value !== null)
      .toSorted();
    return { startedAt: times[0] ?? null, endedAt: times.at(-1) ?? null };
  });
}

function select(
  database: DatabaseSync,
  sql: string,
  ...parameters: string[]
): Array<{ key: string; value: unknown }> {
  try {
    const statement = database.prepare(sql);
    const rows = parameters.length === 0 ? statement.all() : statement.all(...parameters);
    return rows.map((row) => {
      const record = row as { key?: unknown; value?: unknown };
      return {
        key: typeof record.key === 'string' ? record.key : '',
        value: record.value,
      };
    });
  } catch {
    return [];
  }
}

function dailyStat(date: string, value: Record<string, unknown>): CursorDailyStat {
  return {
    date,
    tabSuggestedLines: count(value.tabSuggestedLines),
    tabAcceptedLines: count(value.tabAcceptedLines),
    composerSuggestedLines: count(value.composerSuggestedLines),
    composerAcceptedLines: count(value.composerAcceptedLines),
  };
}

function recentCommitOf(value: Record<string, unknown>): CursorCommitAttribution | null {
  if (typeof value.commitHash !== 'string' || value.commitHash === '') return null;
  return {
    commitHash: value.commitHash,
    repoName: typeof value.repoName === 'string' ? value.repoName : null,
    branchName: typeof value.branchName === 'string' ? value.branchName : null,
    aiPercentage: percentage(value.aiPercentage),
    composerLinesAdded: count(value.composerLinesAdded),
    composerLinesDeleted: count(value.composerLinesDeleted),
    tabLinesAdded: count(value.tabLinesAdded),
    tabLinesDeleted: count(value.tabLinesDeleted),
  };
}

function count(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

function percentage(value: unknown): number | null {
  if (isFiniteNumber(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson(value: unknown): unknown {
  const text = decode(value);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function decode(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return null;
}
