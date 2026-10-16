import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { environmentValue } from '../../env.js';
import { splitConfiguredPaths } from '../paths.js';

export const CURSOR_CONFIG_DIR_ENV = 'CURSOR_CONFIG_DIR';
export const CURSOR_STATE_DB_PATH_ENV = 'CURSOR_STATE_DB_PATH';
const CURSOR_STATE_DB_RELATIVE_PATH = join('User', 'globalStorage', 'state.vscdb');

function getCursorDefaultStateDatabasePath(): string {
  if (process.platform === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Cursor',
      CURSOR_STATE_DB_RELATIVE_PATH,
    );
  }
  if (process.platform === 'win32') {
    const appData = environmentValue('APPDATA') ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Cursor', CURSOR_STATE_DB_RELATIVE_PATH);
  }
  const xdgConfigHome = environmentValue('XDG_CONFIG_HOME') ?? join(homedir(), '.config');
  return join(xdgConfigHome, 'Cursor', CURSOR_STATE_DB_RELATIVE_PATH);
}

function getCursorStateDatabaseCandidates(): string[] {
  const explicitDatabasePath = environmentValue(CURSOR_STATE_DB_PATH_ENV);
  if (explicitDatabasePath) return [resolve(explicitDatabasePath)];

  const configuredDirectories = environmentValue(CURSOR_CONFIG_DIR_ENV);
  if (!configuredDirectories) return [getCursorDefaultStateDatabasePath()];

  return splitConfiguredPaths(configuredDirectories).map((value) => {
    const resolved = resolve(value);
    return resolved.endsWith('.vscdb') ? resolved : join(resolved, CURSOR_STATE_DB_RELATIVE_PATH);
  });
}

export function getCursorStateDatabasePath(): string | null {
  return getCursorStateDatabaseCandidates().find((candidate) => existsSync(candidate)) ?? null;
}
