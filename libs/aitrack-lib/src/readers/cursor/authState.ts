import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export interface CursorAuthState {
  accessToken?: string;
  refreshToken?: string;
}

function normalizeCursorDatabaseValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (value instanceof Uint8Array) {
    const trimmed = Buffer.from(value).toString('utf8').trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return undefined;
}

function readCursorAuthStateFromDatabase(databasePath: string): CursorAuthState {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const query = database.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1');
    const accessRow = query.get('cursorAuth/accessToken') as { value?: unknown } | undefined;
    const refreshRow = query.get('cursorAuth/refreshToken') as { value?: unknown } | undefined;
    return {
      accessToken: normalizeCursorDatabaseValue(accessRow?.value),
      refreshToken: normalizeCursorDatabaseValue(refreshRow?.value),
    };
  } finally {
    database.close();
  }
}

function isSqliteLockedError(error: unknown): boolean {
  return error instanceof Error && /database is locked/iu.test(error.message);
}

async function copyLockedDatabase(databasePath: string, snapshotPath: string): Promise<void> {
  await copyFile(databasePath, snapshotPath);
  for (const suffix of ['-shm', '-wal']) {
    const companionPath = `${databasePath}${suffix}`;
    if (!existsSync(companionPath)) continue;
    await copyFile(companionPath, `${snapshotPath}${suffix}`);
  }
}

/**
 * A consistent copy of the state database.
 *
 * SQLite's backup API includes the WAL, so a read while Cursor is writing is
 * not a torn file copy. If the database is still locked and cannot be opened,
 * fall back to copying the files beside it.
 */
async function snapshotCursorDatabase(databasePath: string, snapshotPath: string): Promise<void> {
  try {
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await backup(source, snapshotPath);
    } finally {
      source.close();
    }
  } catch (error) {
    if (!isSqliteLockedError(error)) throw error;
    await copyLockedDatabase(databasePath, snapshotPath);
  }
}

async function withCursorStateSnapshot<T>(
  databasePath: string,
  callback: (snapshotPath: string) => T | Promise<T>,
): Promise<T> {
  const snapshotDir = await mkdtemp(join(tmpdir(), 'aitrack-cursor-'));
  const snapshotPath = join(snapshotDir, 'state.vscdb');
  try {
    await snapshotCursorDatabase(databasePath, snapshotPath);
    return await callback(snapshotPath);
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }
}

export async function readCursorAuthState(databasePath: string): Promise<CursorAuthState> {
  try {
    return readCursorAuthStateFromDatabase(databasePath);
  } catch (error) {
    if (!isSqliteLockedError(error)) throw error;
    const state = await withCursorStateSnapshot(databasePath, (snapshotPath) =>
      readCursorAuthStateFromDatabase(snapshotPath),
    );
    return state;
  }
}
