import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { previewVersionBump, releaseProblems } from '../release.js';

const RELEASE_SCRIPT_PATH = fileURLToPath(new URL('../release.ts', import.meta.url));

function runRelease(arguments_: string[], cwd: string) {
  return spawnSync(process.execPath, [RELEASE_SCRIPT_PATH, ...arguments_], {
    cwd,
    encoding: 'utf8',
  });
}

function git(cwd: string, ...arguments_: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...arguments_],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function expectedPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/u.exec(version);
  if (!match) throw new Error(`Unexpected package version: ${version}`);
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Unexpected package version: ${version}`);
  }
  return prerelease
    ? `${major}.${minor}.${patch}`
    : `${major}.${minor}.${String(Number(patch) + 1)}`;
}

describe('release tooling', () => {
  it.each([
    ['1.2.3', 'patch', '1.2.4'],
    ['1.2.3', 'preminor', '1.3.0-0'],
    ['1.2.3-beta.2', 'prerelease', '1.2.3-beta.3'],
    ['1.2.3', 'none', '1.2.3'],
  ])('previews %s with a %s bump as %s', (current, bump, expected) => {
    expect(previewVersionBump(current, bump)).toBe(expected);
  });

  describe('from a checkout of a local remote', () => {
    let directory: string;
    let checkout: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'aitrack-release-'));
      checkout = join(directory, 'checkout');
      git(directory, 'init', '--quiet', '--bare', '--initial-branch=main', 'remote.git');
      git(directory, 'init', '--quiet', '--initial-branch=main', 'checkout');
      git(checkout, 'remote', 'add', 'origin', join(directory, 'remote.git'));
      git(checkout, 'commit', '--quiet', '--allow-empty', '-m', 'first');
      git(checkout, 'push', '--quiet', '--set-upstream', 'origin', 'main');
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    const problems = () => releaseProblems('v1.2.3', 'origin', checkout);

    it('previews the next tag and pushes branch and tag atomically', () => {
      const package_ = JSON.parse(
        readFileSync(new URL('../../apps/aitrack/package.json', import.meta.url), 'utf8'),
      ) as {
        version: string;
      };
      const expectedTag = `v${expectedPatchVersion(package_.version)}`;

      const result = runRelease(['patch', '--dry-run'], checkout);

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('would stop');
      expect(result.stdout).toContain(`git-cliff --config .cliff.toml --tag ${expectedTag}`);
      expect(result.stdout).toContain(
        `git push --atomic origin HEAD:refs/heads/main refs/tags/${expectedTag}\n`,
      );
      expect(result.stdout).toContain(`Dry run complete: would release ${expectedTag}.`);
      expect(result.stdout).not.toContain('Release complete:');
    });

    it('passes a clean main that matches its remote', () => {
      expect(problems()).toEqual([]);
    });

    it('rejects another branch', () => {
      git(checkout, 'switch', '--quiet', '--create', 'feature');
      expect(problems()).toEqual(['Releases are cut from main, but this is feature.']);
    });

    it('rejects a dirty tree', () => {
      writeFileSync(join(checkout, 'untracked'), '');
      expect(problems()).toEqual([
        'Working tree is not clean. Commit or stash your changes before releasing.',
      ]);
    });

    it('rejects a HEAD ahead of the remote', () => {
      git(checkout, 'commit', '--quiet', '--allow-empty', '-m', 'unpushed');
      expect(problems()).toEqual(['HEAD is not in sync with origin/main.']);
    });

    it('rejects a HEAD behind the remote', () => {
      git(checkout, 'commit', '--quiet', '--allow-empty', '-m', 'second');
      git(checkout, 'push', '--quiet');
      git(checkout, 'reset', '--quiet', '--hard', 'HEAD~1');
      expect(problems()).toEqual(['HEAD is not in sync with origin/main.']);
    });

    it('rejects a tag that exists locally', () => {
      git(checkout, 'tag', 'v1.2.3');
      expect(problems()).toEqual(['Tag v1.2.3 already exists locally.']);
    });

    it('rejects a tag that exists only on the remote', () => {
      git(checkout, 'tag', 'v1.2.3');
      git(checkout, 'push', '--quiet', 'origin', 'v1.2.3');
      git(checkout, 'tag', '--delete', 'v1.2.3');
      expect(problems()).toEqual(['Tag v1.2.3 already exists on origin.']);
    });

    it('stops a real release before it validates or changes anything', () => {
      git(checkout, 'switch', '--quiet', '--create', 'feature');
      const head = git(checkout, 'rev-parse', 'HEAD');

      const result = runRelease(['patch'], checkout);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Releases are cut from main');
      expect(result.stdout).toBe('');
      expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(checkout, 'tag')).toBe('');
    });
  });

  it('previews successfully in a clean checkout without a configured remote', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'aitrack-release-no-remote-'));
    try {
      const init = spawnSync('git', ['init', '--quiet'], { cwd: checkout, encoding: 'utf8' });
      expect(init.status).toBe(0);

      const result = spawnSync(process.execPath, [RELEASE_SCRIPT_PATH, 'patch', '--dry-run'], {
        cwd: checkout,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('git push --atomic <remote> HEAD:refs/heads/main');
      expect(result.stdout).toContain('Dry run complete: would release');
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
