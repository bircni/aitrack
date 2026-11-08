#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { binaryName, NPM_TARGETS } from './npm-packages.ts';
import { runMain } from './runMain.ts';

const ROOT = resolve(import.meta.dirname, '..');

function pack(directory: string, destination: string): void {
  const result = spawnSync('npm', ['pack', '--pack-destination', destination], {
    cwd: directory,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`npm pack failed in ${directory}`);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Builds the launcher and one package per platform from the release binaries, then packs them. */
function main(): void {
  const [version, binaries, out] = process.argv.slice(2);
  if (version === undefined || binaries === undefined || out === undefined) {
    throw new Error('Usage: npm-pack.ts <version> <binaries-dir> <out-dir>');
  }
  for (const target of Object.keys(NPM_TARGETS)) {
    const path = join(binaries, binaryName(target).asset);
    if (!existsSync(path)) throw new Error(`Missing binary: ${path}`);
  }
  const launcher = JSON.parse(
    readFileSync(join(ROOT, 'npm/aitrack/package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const staging = resolve(out, 'packages');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  for (const [target, name] of Object.entries(NPM_TARGETS)) {
    const [os, cpu] = target.split('-');
    const directory = join(staging, target);
    mkdirSync(join(directory, 'bin'), { recursive: true });
    const { asset, file } = binaryName(target);
    copyFileSync(join(binaries, asset), join(directory, 'bin', file));
    chmodSync(join(directory, 'bin', file), 0o755);
    writeJson(join(directory, 'package.json'), {
      name,
      version,
      description: `The aitrack binary for ${target}; install aitrack instead.`,
      homepage: launcher.homepage,
      license: launcher.license,
      author: launcher.author,
      repository: launcher.repository,
      os: [os],
      cpu: [cpu],
      ...(os === 'linux' && { libc: ['glibc'] }),
      files: [`bin/${file}`],
      publishConfig: launcher.publishConfig,
    });
    pack(directory, resolve(out));
  }

  const directory = join(staging, 'aitrack');
  mkdirSync(join(directory, 'bin'), { recursive: true });
  copyFileSync(join(ROOT, 'npm/aitrack/bin/aitrack.js'), join(directory, 'bin/aitrack.js'));
  copyFileSync(join(ROOT, 'npm/aitrack/targets.json'), join(directory, 'targets.json'));
  copyFileSync(join(ROOT, 'README.md'), join(directory, 'README.md'));
  const optionalDependencies = Object.fromEntries(
    Object.values(NPM_TARGETS).map((name) => [name, version]),
  );
  writeJson(join(directory, 'package.json'), { ...launcher, version, optionalDependencies });
  pack(directory, resolve(out));
}

runMain(import.meta.url, main);
