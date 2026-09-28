import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '/home/test' }));
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => mocks.home };
});

const { getCursorStateDatabasePath } = await import('../location.js');

/** Pretend to be another OS; the default path is platform-specific. */
function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  }
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aitrack-cursor-loc-'));
  delete process.env.CURSOR_CONFIG_DIR;
  delete process.env.CURSOR_STATE_DB_PATH;
  delete process.env.APPDATA;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.CURSOR_CONFIG_DIR;
  delete process.env.CURSOR_STATE_DB_PATH;
  delete process.env.APPDATA;
  delete process.env.XDG_CONFIG_HOME;
});

function makeDatabase(...segments: string[]): string {
  const path = join(directory, ...segments);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'db');
  return path;
}

describe('getCursorStateDatabasePath', () => {
  it('prefers an explicitly configured database file', () => {
    const path = makeDatabase('explicit', 'state.vscdb');
    process.env.CURSOR_STATE_DB_PATH = path;
    expect(getCursorStateDatabasePath()).toBe(path);
  });

  it('ignores a variable that is only whitespace', () => {
    // A blank variable is the same as an unset one; treating " " as a path sent
    // the lookup to the filesystem root.
    makeDatabase('cfg', 'User', 'globalStorage', 'state.vscdb');
    process.env.CURSOR_STATE_DB_PATH = '   ';
    process.env.CURSOR_CONFIG_DIR = join(directory, 'cfg');
    expect(getCursorStateDatabasePath()).toBe(
      join(directory, 'cfg', 'User', 'globalStorage', 'state.vscdb'),
    );
  });

  it('accepts a config directory and appends the standard relative path', () => {
    makeDatabase('cfg', 'User', 'globalStorage', 'state.vscdb');
    process.env.CURSOR_CONFIG_DIR = join(directory, 'cfg');
    expect(getCursorStateDatabasePath()).toBe(
      join(directory, 'cfg', 'User', 'globalStorage', 'state.vscdb'),
    );
  });

  it('takes the first of several configured directories that exists', () => {
    makeDatabase('second', 'User', 'globalStorage', 'state.vscdb');
    process.env.CURSOR_CONFIG_DIR = `${join(directory, 'missing')}, ${join(directory, 'second')}`;
    expect(getCursorStateDatabasePath()).toContain(join('second', 'User'));
  });

  it('returns null when nothing exists', () => {
    process.env.CURSOR_CONFIG_DIR = join(directory, 'nowhere');
    expect(getCursorStateDatabasePath()).toBeNull();
  });

  it('uses the Application Support location on macOS', () => {
    mocks.home = directory;
    makeDatabase(
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    );
    withPlatform('darwin', () => {
      expect(getCursorStateDatabasePath()).toContain(join('Library', 'Application Support'));
    });
  });

  it('uses APPDATA on Windows, falling back to the roaming profile', () => {
    mocks.home = directory;
    makeDatabase('Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    process.env.APPDATA = join(directory, 'Roaming');
    withPlatform('win32', () => {
      expect(getCursorStateDatabasePath()).toContain(join('Roaming', 'Cursor'));
    });
  });

  it('uses XDG_CONFIG_HOME elsewhere', () => {
    mocks.home = directory;
    makeDatabase('xdg', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    process.env.XDG_CONFIG_HOME = join(directory, 'xdg');
    withPlatform('linux', () => {
      expect(getCursorStateDatabasePath()).toContain(join('xdg', 'Cursor'));
    });
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    mocks.home = directory;
    makeDatabase('.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    withPlatform('linux', () => {
      expect(getCursorStateDatabasePath()).toContain(join('.config', 'Cursor'));
    });
  });
});
