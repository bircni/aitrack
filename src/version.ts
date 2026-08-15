import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let resolved: string | undefined;

/**
 * The running aitrack version, read from the packaged package.json.
 *
 * Falls back to "0.0.0" when the file is missing or malformed — `--version`
 * printing a placeholder is better than the CLI refusing to start, and the
 * parse cache treats an unknown version as "always stale", which is safe.
 */
export function packageVersion(): string {
  if (resolved !== undefined) return resolved;

  const packagePath = join(import.meta.dirname, '../package.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string' &&
      parsed.version.length > 0
    ) {
      resolved = parsed.version;
      return resolved;
    }
  } catch {
    // fall through to the placeholder below
  }
  resolved = '0.0.0';
  return resolved;
}
