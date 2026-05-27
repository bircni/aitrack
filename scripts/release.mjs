#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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

function run(command, args, options = {}) {
  const pretty = [command, ...args].join(' ');
  if (options.dryRun) {
    console.log(`[dry-run] ${pretty}`);
    return;
  }

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${pretty}`);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...args].join(' ')}`);
  }
  return result.stdout.trim();
}

function getPackageVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

function parseArgs(argv) {
  const bumpArg = argv.find((arg) => !arg.startsWith('--')) || 'patch';
  if (!ALLOWED_BUMPS.has(bumpArg)) {
    throw new Error(
      `Invalid bump type: ${bumpArg}. Use one of: ${Array.from(ALLOWED_BUMPS).join(', ')}`,
    );
  }

  return {
    bump: bumpArg,
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
  const { bump, dryRun } = parseArgs(process.argv.slice(2));
  const opts = { dryRun };

  ensureCleanGitTree(dryRun);

  run('pnpm', ['run', 'validate'], opts);
  run('pnpm', ['run', 'build'], opts);

  if (bump !== 'none') {
    run('pnpm', ['version', bump, '--no-git-tag-version'], opts);
  }
  const version = getPackageVersion();
  const tag = `v${version}`;

  run('git-cliff', ['--config', '.cliff.toml', '--tag', tag, '-o', 'CHANGELOG.md'], opts);

  run('git', ['add', 'package.json', 'pnpm-lock.yaml', 'CHANGELOG.md'], opts);
  run('git', ['commit', '-m', `chore(release): ${tag}`], opts);
  run('git', ['tag', tag], opts);

  run('git', ['push'], opts);
  run('git', ['push', '--tags'], opts);

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
