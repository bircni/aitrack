import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `version` field of the package.json one directory above `directory`.
 *
 * Falls back to "0.0.0" when the file is missing or malformed — `--version`
 * printing a placeholder is better than the CLI refusing to start, and the
 * parse cache treats an unknown version as "always stale", which is safe.
 *
 * Both packages need this and neither can read the other's package.json, so
 * the reader is shared and each package points it at its own install root.
 */
export function readPackageVersion(directory: string): string {
  const packagePath = join(directory, '../package.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string' &&
      parsed.version.length > 0
    ) {
      return parsed.version;
    }
  } catch {
    // fall through to the placeholder below
  }
  return '0.0.0';
}

let resolved: string | undefined;

/**
 * The running aitrack-lib version.
 *
 * Used as a cache key: a parse cache written by a different version of this
 * library is discarded rather than trusted.
 */
export function packageVersion(): string {
  resolved ??= readPackageVersion(import.meta.dirname);
  return resolved;
}
