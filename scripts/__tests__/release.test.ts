import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { previewVersionBump } from '../release.js';

const REPO_ROOT_PATH = fileURLToPath(new URL('../..', import.meta.url));
const RELEASE_SCRIPT_PATH = fileURLToPath(new URL('../release.ts', import.meta.url));

function runRelease(arguments_: string[]) {
  return spawnSync(process.execPath, [RELEASE_SCRIPT_PATH, ...arguments_], {
    cwd: REPO_ROOT_PATH,
    encoding: 'utf8',
  });
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

  it('previews the next tag and pushes only that exact tag', () => {
    const package_ = JSON.parse(
      readFileSync(new URL('../../apps/aitrack/package.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
    };
    const expectedTag = `v${expectedPatchVersion(package_.version)}`;

    const result = runRelease(['patch', '--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`git-cliff --config .cliff.toml --tag ${expectedTag}`);
    expect(result.stdout).toMatch(
      new RegExp(`git push \\S+ refs/tags/${expectedTag.replaceAll('.', '\\.')}`, 'u'),
    );
    expect(result.stdout).toContain(`Dry run complete: would release ${expectedTag}.`);
    expect(result.stdout).not.toContain('git push --tags');
    expect(result.stdout).not.toContain('Release complete:');
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
      expect(result.stdout).toContain('git push <remote> HEAD');
      expect(result.stdout).toContain('Dry run complete: would release');
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
