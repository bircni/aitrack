import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// All read through environmentValue, which treats blank as unset.
const SOURCE_OVERRIDES = [
  'AITRACK_CLAUDE_PROJECTS_DIRS',
  'AITRACK_CODEX_SESSION_DIRS',
  'AITRACK_NO_CACHE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CURSOR_CONFIG_DIR',
  'CURSOR_STATE_DB_PATH',
  'XDG_CONFIG_HOME',
];

/**
 * The tests must never read or write the developer's real data, so HOME and the variables that
 * override it are pinned. chalk picks colour from the ambient TTY, so that is pinned too.
 */
export function isolatedTestEnv(): Record<string, string> {
  const home = join(tmpdir(), 'aitrack-vitest-home');
  mkdirSync(home, { recursive: true });
  return {
    ...Object.fromEntries(SOURCE_OVERRIDES.map((name) => [name, ''])),
    FORCE_COLOR: '0',
    HOME: home,
    USERPROFILE: home,
  };
}
