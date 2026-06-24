#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';

const IS_WIN = platform() === 'win32';

/** Quote args for cmd.exe when shell mode joins them into one command string. */
function quoteShellArgument(argument) {
  if (!/[\s()&|<>^"'%!]/.test(argument)) return argument;
  return `"${argument.replaceAll('"', String.raw`\"`)}"`;
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

function run(command, arguments_, options = {}) {
  const pretty = [command, ...arguments_].join(' ');
  if (options.dryRun) {
    console.log(`[dry-run] ${pretty}`);
    return;
  }

  const spawnOptions = { stdio: 'inherit', ...options };
  const result = IS_WIN
    ? spawnSync([command, ...arguments_.map(quoteShellArgument)].join(' '), {
        ...spawnOptions,
        shell: true,
      })
    : spawnSync(command, arguments_, spawnOptions);

  if (result.status !== 0) {
    throw new Error(`Command failed: ${pretty}`);
  }
}

function output(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...arguments_].join(' ')}`);
  }
  return result.stdout.trim();
}

function getPackageVersion() {
  const package_ = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return package_.version;
}

function parseArguments(argv) {
  const bumpArgument = argv.find((argument) => !argument.startsWith('--')) || 'patch';
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

function ensureCleanGitTree(dryRun) {
  const dirty = output('git', ['status', '--porcelain']);
  if (dirty !== '') {
    if (dryRun) {
      console.warn('Working tree is not clean; continuing because --dry-run was used.');
      return;
    }
    throw new Error('Working tree is not clean. Commit or stash your changes before releasing.');
  }
}

function main() {
  const { bump, dryRun } = parseArguments(process.argv.slice(2));
  const options = { dryRun };

  ensureCleanGitTree(dryRun);

  run('pnpm', ['run', 'validate'], options);
  run('pnpm', ['run', 'build'], options);

  if (bump !== 'none') {
    run('pnpm', ['version', bump, '--no-git-tag-version'], options);
  }
  const version = getPackageVersion();
  const tag = `v${version}`;

  run('git-cliff', ['--config', '.cliff.toml', '--tag', tag, '-o', 'CHANGELOG.md'], options);

  run('git', ['add', 'package.json', 'pnpm-lock.yaml', 'CHANGELOG.md'], options);
  run('git', ['commit', '-m', `chore(release): ${tag}`], options);
  run('git', ['tag', tag], options);

  run('git', ['push'], options);
  run('git', ['push', '--tags'], options);

  console.log(`Release complete: ${tag}`);
  console.log(
    'npm publish runs in GitHub Actions when the tag is pushed (requires NPM_TOKEN secret).',
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
