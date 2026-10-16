import { readPackageVersion } from 'aitrack-lib/version';

let resolved: string | undefined;

/** The CLI's own version, so --version names the invoked binary, not the linked library. */
export function cliVersion(): string {
  resolved ??= readPackageVersion(import.meta.dirname);
  return resolved;
}
