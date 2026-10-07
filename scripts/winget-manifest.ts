#!/usr/bin/env tsx
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const IDENTIFIER = 'bircni.opentrack';
const MANIFEST_VERSION = '1.12.0';
/** `bundle.publisher` and the product name in tauri.conf.json, which the installer writes to the registry. */
const PUBLISHER = 'bircni';
const PRODUCT = 'opentrack';

function header(type: string): string {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${MANIFEST_VERSION}.schema.json\n\n`;
}

function footer(type: string): string {
  return `ManifestType: ${type}\nManifestVersion: ${MANIFEST_VERSION}\n`;
}

/** The three files winget-pkgs expects for one version, keyed by file name. */
function renderManifests(version: string, sha256: string): Record<string, string> {
  const id = `PackageIdentifier: ${IDENTIFIER}\nPackageVersion: ${version}\n`;
  return {
    [`${IDENTIFIER}.yaml`]: `${header('version')}${id}DefaultLocale: en-US\n${footer('version')}`,
    [`${IDENTIFIER}.installer.yaml`]: `${header('installer')}${id}InstallerLocale: en-US
InstallerType: nullsoft
Scope: user
InstallModes:
- interactive
- silent
- silentWithProgress
UpgradeBehavior: install
ProductCode: ${PRODUCT}
Installers:
- Architecture: x64
  InstallerUrl: https://github.com/bircni/aitrack/releases/download/v${version}/opentrack_${version}_x64-setup.exe
  InstallerSha256: ${sha256.toUpperCase()}
${footer('installer')}`,
    [`${IDENTIFIER}.locale.en-US.yaml`]: `${header('defaultLocale')}${id}PackageLocale: en-US
Publisher: ${PUBLISHER}
PublisherUrl: https://github.com/bircni
PublisherSupportUrl: https://github.com/bircni/aitrack/issues
PackageName: ${PRODUCT}
PackageUrl: https://github.com/bircni/aitrack/blob/main/docs/opentrack.md
License: MIT
LicenseUrl: https://github.com/bircni/aitrack/blob/main/LICENSE
ShortDescription: Live limits, reset times and spend for Claude Code, Codex and Cursor
Description: |-
  A tray dashboard for Claude Code, Codex and Cursor: live session and weekly limits with reset
  times and pacing, plus token usage and estimated cost, including other machines synced through
  an aitrack data repo.
Moniker: ${PRODUCT}
Tags:
- ai
- claude-code
- codex
- cursor
- tray
- usage
ReleaseNotesUrl: https://github.com/bircni/aitrack/releases/tag/v${version}
${footer('defaultLocale')}`,
  };
}

function main(): void {
  const [tag, installerPath, outRoot = '.'] = process.argv.slice(2);
  if (!tag || !installerPath) {
    throw new Error('Usage: tsx scripts/winget-manifest.ts <tag> <setup-exe> [winget-pkgs-dir]');
  }
  const version = tag.replace(/^v/u, '');
  const sha256 = createHash('sha256').update(readFileSync(installerPath)).digest('hex');
  const directory = join(outRoot, 'manifests', 'b', 'bircni', PRODUCT, version);
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(renderManifests(version, sha256))) {
    writeFileSync(join(directory, name), contents);
  }
  process.stdout.write(`${directory}\n`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
