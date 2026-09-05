import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Every directory aitrack owns under the user's home.
 *
 * These were previously rebuilt from `homedir()` in four separate modules, so
 * moving the application directory meant finding all four. They are evaluated
 * at module load time: the test suite mocks `node:os` before importing anything
 * that reaches these, and making them lazy would break that arrangement.
 */
export const APP_DIR = join(homedir(), '.config', 'aitrack');

export const CONFIG_PATH = join(APP_DIR, 'config.json');

/** Clone of the user's data repo. */
export const LOCAL_REPO = join(APP_DIR, 'repo');

/** Machine JSON files inside the clone. */
export const DATA_DIR = join(LOCAL_REPO, 'data');

/** Spool for machine files written while the repo was unavailable. */
export const PENDING_DATA_DIR = join(APP_DIR, 'pending', 'data');

/** Parsed-transcript cache, keyed by source mtime and size. */
export const CACHE_DIR = join(APP_DIR, 'cache');
