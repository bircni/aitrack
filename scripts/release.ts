#!/usr/bin/env tsx
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

function readRepoPackage(): { version: string; packageManager?: string } {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
    packageManager?: string;
  };
}

function getPackageVersion(): string {
  return readRepoPackage().version;
}

/** Ask pnpm to calculate a bump in an isolated directory without touching the checkout. */
export function previewVersionBump(currentVersion: string, bump: string): string {
  if (bump === 'none') return currentVersion;

  const previewDirectory = mkdtempSync(join(tmpdir(), 'aitrack-release-preview-'));
  const previewPackagePath = join(previewDirectory, 'package.json');
  try {
    // pnpm resolves `packageManager` by walking up from cwd, so without our own
    // field it adopts whatever package.json sits above the temp dir — on Windows
    // that search reaches the user's home directory and can select a different
    // package manager entirely.
    const { packageManager } = readRepoPackage();
    writeFileSync(
      previewPackagePath,
      `${JSON.stringify({
        name: 'aitrack-release-preview',
        version: currentVersion,
        private: true,
        ...(packageManager === undefined ? {} : { packageManager }),
      })}\n`,
      'utf8',
    );
    const result = spawnCommand('pnpm', ['version', bump, '--no-git-tag-version'], {
      cwd: previewDirectory,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      throw new Error(`Could not preview ${bump} version bump${detail ? `: ${detail}` : ''}`);
    }

    const package_ = JSON.parse(readFileSync(previewPackagePath, 'utf8')) as { version?: unknown };
    if (typeof package_.version !== 'string') {
      throw new TypeError('pnpm version preview did not produce a package version');
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
  if (!ALLOWED_BUMPS.has(bumpArgument)) {
    throw new Error(
      `Invalid bump type: ${bumpArgument}. Use one of: ${[...ALLOWED_BUMPS].join(', ')}`,
    );
  }

  return {
    bump: bumpArgument,
    dryRun: argv.includes('--dry-run'),
  };
}

function ensureCleanGitTree(dryRun: boolean): void {
  const dirty = output('git', ['status', '--porcelain']);
  if (dirty !== '') {
    if (dryRun) {
      console.warn('Working tree is not clean; continuing because --dry-run was used.');
      return;
    }
    throw new Error('Working tree is not clean. Commit or stash your changes before releasing.');
  }
}

function main(): void {
  const { bump, dryRun } = parseArguments(process.argv.slice(2));
  const options = { dryRun };

  ensureCleanGitTree(dryRun);
  const pushRemote = getPushRemote({ allowPlaceholder: dryRun });

  run('pnpm', ['run', 'validate'], options);
  run('pnpm', ['run', 'build'], options);

  const currentVersion = getPackageVersion();
  if (bump !== 'none') {
    run('pnpm', ['version', bump, '--no-git-tag-version'], options);
  }
  const version = dryRun ? previewVersionBump(currentVersion, bump) : getPackageVersion();
  const tag = `v${version}`;

  run('git-cliff', ['--config', '.cliff.toml', '--tag', tag, '-o', 'CHANGELOG.md'], options);

  run('git', ['add', 'package.json', 'pnpm-lock.yaml', 'CHANGELOG.md'], options);
  run('git', ['commit', '-m', `chore(release): ${tag}`], options);
  run('git', ['tag', tag], options);

  run('git', ['push', pushRemote, 'HEAD'], options);
  run('git', ['push', pushRemote, `refs/tags/${tag}`], options);

  if (dryRun) {
    console.log(`Dry run complete: would release ${tag}. No repository files were changed.`);
  } else {
    console.log(`Release complete: ${tag}`);
    console.log(
      'npm publish and GitHub Release creation run in GitHub Actions after the tag is pushed.',
    );
  }
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
