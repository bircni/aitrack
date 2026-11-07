#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { runMain } from './runMain.ts';

const LIBRARY_FIRST = ['aitrack-lib', 'aitrack']; // The CLI pins the library's exact version.

function isPublished(name: string, version: string): boolean {
  const view = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
  return view.status === 0 && view.stdout.trim() === version;
}

function main(): void {
  const [tag, directory] = process.argv.slice(2);
  if (tag === undefined || directory === undefined) {
    throw new Error('Usage: publish-npm.ts <vX.Y.Z> <tarball-dir>');
  }
  const version = tag.replace(/^v/u, '');
  // The leading ./ stops npm reading the path as a GitHub shorthand.
  const tarballs = LIBRARY_FIRST.map((name) => ({
    name,
    path: `./${directory}/${name}-${version}.tgz`,
  }));
  for (const { path } of tarballs) {
    if (!existsSync(path)) throw new Error(`Missing tarball: ${path}`);
  }

  for (const { name, path } of tarballs) {
    if (isPublished(name, version)) {
      console.log(`${name}@${version} is already on the registry, skipping.`);
      continue;
    }
    // npm refuses a prerelease without a dist-tag, so it can never become `latest`.
    const distTag = version.includes('-') ? ['--tag', 'next'] : [];
    const publish = spawnSync('npm', ['publish', path, '--provenance', ...distTag], {
      stdio: 'inherit',
    });
    if (publish.status !== 0) throw new Error(`npm publish failed for ${path}`);
  }
}

runMain(import.meta.url, main);
