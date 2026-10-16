import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isRecord } from './data/guards.js';

/** Version one level above `directory`; "0.0.0" if unreadable, which the parse cache treats as stale. */
export function readPackageVersion(directory: string): string {
  const packagePath = join(directory, '../package.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (isRecord(parsed) && typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {}
  return '0.0.0';
}

/** Set by bundles that ship without a package.json beside them (opentrack's sidecar). */
declare const __AITRACK_LIB_VERSION__: string | undefined;

let resolved: string | undefined;

/** Keys the parse caches, so one written by another version is discarded. */
export function packageVersion(): string {
  resolved ??=
    typeof __AITRACK_LIB_VERSION__ === 'string'
      ? __AITRACK_LIB_VERSION__
      : readPackageVersion(import.meta.dirname);
  return resolved;
}
