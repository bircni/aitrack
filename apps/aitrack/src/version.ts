import { readPackageVersion } from 'aitrack-lib/version';

let resolved: string | undefined;

/**
 * The running aitrack CLI version, as printed by `--version`.
 *
 * Deliberately the CLI's own package.json rather than `packageVersion()` from
 * the library: the two are released together, but `--version` should report
 * the binary the user invoked, not the library it happens to link against.
 */
export function cliVersion(): string {
  resolved ??= readPackageVersion(import.meta.dirname);
  return resolved;
}
