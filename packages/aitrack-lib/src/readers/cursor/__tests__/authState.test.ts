import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  backup: vi.fn((_source: unknown, _path: unknown) => Promise.resolve(1)),
}));

// The locked-database path cannot be provoked reliably with a real SQLite file
// across platforms, so the driver is mocked and the recovery is what is tested.
vi.mock('node:sqlite', () => ({
  backup: mocks.backup,
  DatabaseSync: class {
    constructor(path: string) {
      mocks.open(path);
    }
    prepare() {
      return {
        get: (key: string) =>
          key === 'cursorAuth/accessToken' ? { value: 'access-token' } : { value: 'refresh-token' },
      };
    }
    close() {
      // nothing to release in the fake
    }
  },
}));

const { readCursorAuthState } = await import('../authState.js');

let directory: string;
let databasePath: string;

beforeEach(() => {
  mocks.open.mockReset();
  mocks.backup.mockReset();
  mocks.backup.mockResolvedValue(1);
  directory = mkdtempSync(join(tmpdir(), 'aitrack-cursor-state-'));
  databasePath = join(directory, 'state.vscdb');
  writeFileSync(databasePath, 'not-really-sqlite');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('readCursorAuthState', () => {
  it('reads the tokens straight from the database when it is not locked', async () => {
    await expect(readCursorAuthState(databasePath)).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.backup).not.toHaveBeenCalled();
  });

  it('retries against a sqlite backup when Cursor holds the database open', async () => {
    // Cursor keeps state.vscdb locked while it is running, which is most of the
    // time. Failing there would make the whole provider unusable, so the file is
    // snapshotted with SQLite's backup API and read from the copy.
    mocks.open.mockImplementationOnce((path: string) => {
      throw new Error(`database is locked: ${path}`);
    });

    await expect(readCursorAuthState(databasePath)).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });

    expect(mocks.backup).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledTimes(3);
    const paths = mocks.open.mock.calls.map((call) => call[0] as string);
    expect(paths[0]).toBe(databasePath);
    expect(paths[1]).toBe(databasePath);
    expect(paths[2]).not.toBe(databasePath);
    expect(paths[2]).toContain('state.vscdb');
  });

  it('copies the -wal and -shm companions alongside the snapshot', async () => {
    // A WAL database's recent writes live in the companion files; copying only
    // the main file would read a stale token, or none at all.
    writeFileSync(`${databasePath}-wal`, 'wal');
    writeFileSync(`${databasePath}-shm`, 'shm');
    let snapshotDirectory = '';
    mocks.open.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    mocks.open.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    mocks.open.mockImplementationOnce((path: string) => {
      snapshotDirectory = join(path, '..');
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(existsSync(`${path}-shm`)).toBe(true);
    });

    await readCursorAuthState(databasePath);

    // The snapshot directory is removed afterwards, so check it is gone rather
    // than leaking into the temp directory.
    expect(snapshotDirectory).not.toBe('');
    expect(existsSync(snapshotDirectory)).toBe(false);
  });

  it('rethrows an error that is not a lock', async () => {
    // Only a locked database is worth retrying; a corrupt one would fail the
    // same way twice and the real error should reach the user.
    mocks.open.mockImplementation(() => {
      throw new Error('file is not a database');
    });

    await expect(readCursorAuthState(databasePath)).rejects.toThrow('file is not a database');
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });
});
