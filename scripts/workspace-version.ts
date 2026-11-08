import { readFileSync } from 'node:fs';

/** The one version the CLI, opentrack and the npm packages all carry. */
export const WORKSPACE_VERSION = /(\[workspace\.package\][^[]*?\nversion = ")([^"]+)(")/u;

export const CARGO_TOML = new URL('../Cargo.toml', import.meta.url);

export function getWorkspaceVersion(cargoToml = readFileSync(CARGO_TOML, 'utf8')): string {
  const version = WORKSPACE_VERSION.exec(cargoToml)?.[2];
  if (version === undefined) throw new Error('Cargo.toml has no [workspace.package] version');
  return version;
}
