#!/usr/bin/env tsx
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMain } from './runMain.ts';
import { CARGO_TOML, getWorkspaceVersion, WORKSPACE_VERSION } from './workspace-version.ts';

const IS_WIN = platform() === 'win32';

/** Quote args for cmd.exe when shell mode joins them into one command string. */
function quoteShellArgument(argument: string): string {
  if (!/[\s()&|<>^"'%!]/u.test(argument)) return argument;
  return `"${argument.replaceAll('"', String.raw`\"`)}"`;
}

/**
 * Every caller that reads `stdout`/`stderr` passes `encoding: 'utf8'`, so the
 * result is narrowed to the string variant; `run()` only inspects `status`.
 */
function spawnCommand(
  command: string,
  arguments_: string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string> {
  return (
    IS_WIN
      ? spawnSync(
          [command, ...arguments_.map((argument) => quoteShellArgument(argument))].join(' '),
          {
            ...options,
            shell: true,
          },
        )
      : spawnSync(command, arguments_, options)
  ) as SpawnSyncReturns<string>;
}

/** An exact version, such as the first of a prerelease series. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?$/u;

const ALLOWED_BUMPS = new Set([
  'none',
  'patch',
  'minor',
  'major',
  'prepatch',
  'preminor',
  'premajor',
  'prerelease',
]);

interface RunOptions extends SpawnSyncOptions {
  dryRun?: boolean;
}

function run(
  command: string,
  arguments_: string[],
  { dryRun = false, ...spawnOptions }: RunOptions = {},
): void {
  const pretty = [command, ...arguments_].join(' ');
  if (dryRun) {
    console.log(`[dry-run] ${pretty}`);
    return;
  }

  const result = spawnCommand(command, arguments_, { stdio: 'inherit', ...spawnOptions });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${pretty}`);
  }
}

function output(command: string, arguments_: string[]): string {
  const result = spawnCommand(command, arguments_, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...arguments_].join(' ')}`);
  }
  return result.stdout.trim();
}

function optionalOutput(command: string, arguments_: string[]): string | undefined {
  const result = spawnCommand(command, arguments_, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

const RELEASE_BRANCH = 'main';

function setWorkspaceVersion(version: string, options: RunOptions): void {
  if (options.dryRun) {
    console.log(`[dry-run] set [workspace.package] version = "${version}"`);
  } else {
    const cargoToml = readFileSync(CARGO_TOML, 'utf8');
    writeFileSync(CARGO_TOML, cargoToml.replace(WORKSPACE_VERSION, `$1${version}$3`));
  }
  run('cargo', ['update', '--workspace'], options); // Cargo.lock records each crate's version.
}

/** Ask bun to calculate a bump in an isolated directory without touching the checkout. */
export function previewVersionBump(currentVersion: string, bump: string): string {
  if (bump === 'none') return currentVersion;

  const previewDirectory = mkdtempSync(join(tmpdir(), 'aitrack-release-preview-'));
  const previewPackagePath = join(previewDirectory, 'package.json');
  try {
    writeFileSync(
      previewPackagePath,
      `${JSON.stringify({ name: 'aitrack-release-preview', version: currentVersion, private: true })}\n`,
      'utf8',
    );
    const result = spawnCommand('bun', ['pm', 'version', bump, '--no-git-tag-version'], {
      cwd: previewDirectory,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      throw new Error(`Could not preview ${bump} version bump${detail ? `: ${detail}` : ''}`);
    }

    const package_ = JSON.parse(readFileSync(previewPackagePath, 'utf8')) as { version?: unknown };
    if (typeof package_.version !== 'string') {
      throw new TypeError('bun version preview did not produce a package version');
    }
    return package_.version;
  } finally {
    rmSync(previewDirectory, { recursive: true, force: true });
  }
}

function getPushRemote({ allowPlaceholder = false }: { allowPlaceholder?: boolean } = {}): string {
  const branch = output('git', ['branch', '--show-current']);
  const configured = [
    optionalOutput('git', ['config', '--get', `branch.${branch}.pushRemote`]),
    optionalOutput('git', ['config', '--get', 'remote.pushDefault']),
    optionalOutput('git', ['config', '--get', `branch.${branch}.remote`]),
  ].find(Boolean);
  if (configured !== undefined) return configured;

  const remotes = output('git', ['remote'])
    .split('\n')
    .filter((remote) => remote.length > 0);
  if (remotes.includes('origin')) return 'origin';
  const [onlyRemote] = remotes;
  if (remotes.length === 1 && onlyRemote !== undefined) return onlyRemote;
  if (allowPlaceholder) return '<remote>';
  throw new Error('Could not determine push remote. Configure an upstream or remote.pushDefault.');
}

interface ParsedArguments {
  bump: string;
  dryRun: boolean;
}

function parseArguments(argv: string[]): ParsedArguments {
  const bumpArgument = argv.find((argument) => !argument.startsWith('--')) ?? 'patch';
  if (!ALLOWED_BUMPS.has(bumpArgument) && !EXACT_VERSION.test(bumpArgument)) {
    throw new Error(
      `Invalid bump type: ${bumpArgument}. Use one of: ${[...ALLOWED_BUMPS].join(', ')}, or a version`,
    );
  }

  return {
    bump: bumpArgument,
    dryRun: argv.includes('--dry-run'),
  };
}

/** Everything that would make this release fail halfway or tag the wrong commit. */
export function releaseProblems(tag: string, remote: string, cwd?: string): string[] {
  const git = (arguments_: string[]) => spawnCommand('git', arguments_, { cwd, encoding: 'utf8' });
  const problems: string[] = [];
  const expected = RELEASE_BRANCH;

  const branch = git(['branch', '--show-current']).stdout.trim();
  if (branch !== expected) {
    problems.push(`${tag} is cut from ${expected}, but this is ${branch || 'detached HEAD'}.`);
  }
  if (git(['status', '--porcelain']).stdout.trim() !== '') {
    problems.push('Working tree is not clean. Commit or stash your changes before releasing.');
  }
  if (git(['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`]).status === 0) {
    problems.push(`Tag ${tag} already exists locally.`);
  }

  const branchRef = `refs/heads/${expected}`;
  const tagRef = `refs/tags/${tag}`;
  const remoteRefs = git(['ls-remote', remote, branchRef, tagRef]); // Unlike fetch, changes nothing here.
  if (remoteRefs.status !== 0) {
    problems.push(`Could not read ${remote}: ${remoteRefs.stderr.trim()}`);
    return problems;
  }
  const refs = new Map(
    remoteRefs.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split('\t');
        return [ref, sha];
      }),
  );
  if (refs.has(tagRef)) problems.push(`Tag ${tag} already exists on ${remote}.`);
  if (refs.get(branchRef) !== git(['rev-parse', 'HEAD']).stdout.trim()) {
    problems.push(`HEAD is not in sync with ${remote}/${expected}.`);
  }
  return problems;
}

function main(): void {
  const { bump, dryRun } = parseArguments(process.argv.slice(2));
  const options = { dryRun };

  const pushRemote = getPushRemote({ allowPlaceholder: dryRun });
  const version = previewVersionBump(getWorkspaceVersion(), bump);
  const tag = `v${version}`;

  const problems = releaseProblems(tag, pushRemote);
  if (problems.length > 0 && !dryRun) throw new Error(problems.join('\n'));
  for (const problem of problems) console.warn(`A real release would stop here: ${problem}`);

  run('just', ['validate'], options);

  if (bump !== 'none') setWorkspaceVersion(version, options);

  run('git-cliff', ['--config', '.cliff.toml', '--tag', tag, '-o', 'CHANGELOG.md'], options);

  run('git', ['add', 'Cargo.toml', 'Cargo.lock', 'CHANGELOG.md'], options);
  run('git', ['commit', '-m', `chore(release): ${tag}`], options);
  run('git', ['tag', tag], options);

  // Atomic: a release commit without its tag would never publish.
  run(
    'git',
    ['push', '--atomic', pushRemote, `HEAD:refs/heads/${RELEASE_BRANCH}`, `refs/tags/${tag}`],
    options,
  );

  if (dryRun) {
    console.log(`Dry run complete: would release ${tag}. No repository files were changed.`);
  } else {
    console.log(`Release complete: ${tag}`);
    console.log(
      'npm publish and GitHub Release creation run in GitHub Actions after the tag is pushed.',
    );
  }
}

runMain(import.meta.url, main);
