#!/usr/bin/env tsx
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Tauri updater target per installer the release workflow builds. */
const PLATFORMS = [
  { key: 'darwin-aarch64', suffix: '.app.tar.gz' },
  { key: 'windows-x86_64', suffix: '-setup.exe' },
] as const;

interface UpdaterManifest {
  version: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

function buildManifest(
  tag: string,
  directory: string,
  repository: string,
  now: Date,
): UpdaterManifest {
  const files = readdirSync(directory);
  const platforms: UpdaterManifest['platforms'] = {};
  for (const { key, suffix } of PLATFORMS) {
    const matches = files.filter((file) => file.endsWith(suffix));
    if (matches.length !== 1) {
      throw new Error(`Expected one *${suffix} in ${directory}, found ${String(matches.length)}.`);
    }
    const [file = ''] = matches;
    if (!files.includes(`${file}.sig`)) throw new Error(`${file} has no updater signature.`);
    platforms[key] = {
      signature: readFileSync(join(directory, `${file}.sig`), 'utf8').trim(),
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(file)}`,
    };
  }
  return { version: tag.replace(/^v/u, ''), pub_date: now.toISOString(), platforms };
}

function main(): void {
  const [tag, directory, repository = process.env.GITHUB_REPOSITORY] = process.argv.slice(2);
  if (!tag || !directory || !repository) {
    throw new Error('Usage: tsx scripts/updater-manifest.ts <tag> <installers-dir> [owner/repo]');
  }
  const manifest = buildManifest(tag, directory, repository, new Date());
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
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
