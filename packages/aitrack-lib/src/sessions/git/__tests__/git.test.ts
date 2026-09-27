import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isTestPath } from '../../testPaths.js';
import { GitCommandError, assertAllowedGitArgs } from '../allow.js';
import {
  measureBlame,
  readBranchesContaining,
  readCommitsOnBranches,
  readCommitLog,
  readCommitRefs,
  readRemoteUrl,
  readRepoRoot,
  runAllowedGit,
} from '../inspect.js';
import { churnFromBlame, countAttributedLines, parseBranchList, parseGitLog } from '../parse.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aitrack-git-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

describe('assertAllowedGitArgs', () => {
  it('refuses every command that would change a repo or the network', () => {
    for (const command of [
      'push',
      'fetch',
      'reset',
      'checkout',
      'commit',
      'stash',
      'rebase',
      'clean',
      'status',
    ]) {
      expect(() => {
        assertAllowedGitArgs([command]);
      }).toThrow(GitCommandError);
    }
    expect(() => {
      assertAllowedGitArgs(['log', 'reset']);
    }).toThrow(GitCommandError);
    expect(() => {
      assertAllowedGitArgs(['log', '--numstat']);
    }).not.toThrow();
  });
});

describe('parseGitLog', () => {
  it('reads a record, a revert trailer and numstat', () => {
    const output = [
      '\u001Eabcdef1234567890\u001F\u001F1700000000\u001F1700000001\u001Fada@example.com\u001Ffix button\u001FThis reverts commit deadbeef\u001C',
      '3\t1\tsrc/app.ts',
      '2\t0\tsrc/__tests__/app.test.ts',
      '-\t-\timage.png',
    ].join('\n');
    const commits = parseGitLog(output);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      sha: 'abcdef1234567890',
      isRevert: true,
      revertOf: 'deadbeef',
      authorEmail: 'ada@example.com',
    });
    expect(commits[0]?.files[0]).toEqual({ path: 'src/app.ts', insertions: 3, deletions: 1 });
    expect(commits[0]?.files[2]).toEqual({ path: 'image.png', insertions: 0, deletions: 0 });
    expect(isTestPath(commits[0]?.files[1]?.path ?? '')).toBe(true);
    expect(commits[0]?.authorTime).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  it('parses branch names and blame attribution', () => {
    expect(parseBranchList('* main\n  remotes/origin/feature\n')).toEqual(['main', 'feature']);
    const porcelain = [
      'abcdef1 1 1 1',
      'author Ada',
      '\tconst a = 1;',
      'bbbbbbb 2 2 1',
      '\tconst b = 2;',
    ].join('\n');
    expect(countAttributedLines(porcelain, 'abcdef1')).toBe(1);
    expect(churnFromBlame(2, porcelain, 'abcdef1')).toEqual({
      linesRewritten: 1,
      linesTotal: 2,
      ratio: 0.5,
    });
    expect(churnFromBlame(0, porcelain, 'abcdef1')).toBeNull();
  });
});

describe('readCommitLog', () => {
  it('imports a synthetic repo and measures surviving lines', async () => {
    git(tmpDir, ['init', '-b', 'main']);
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'app.ts'), 'export const value = 1;\n');
    git(tmpDir, ['add', 'src/app.ts']);
    git(tmpDir, ['commit', '-m', 'add app']);
    const root = await readRepoRoot(tmpDir);
    expect(root).toBe(realpathSync(tmpDir));
    const commits = await readCommitLog(tmpDir, '2020-01-01T00:00:00Z');
    expect(commits).toHaveLength(1);
    const refs = await readCommitRefs(tmpDir);
    expect(refs.get(commits[0]?.sha ?? '')).toContain('main');
    expect(commits[0]?.files[0]?.path).toBe('src/app.ts');
    expect(commits[0]?.subject).toBe('add app');

    const sha = commits[0]?.sha ?? '';
    const kept = await measureBlame(tmpDir, sha, 'src/app.ts');
    expect(kept.skipped).toBe(false);
    expect(kept.surviving).toBe(1);

    writeFileSync(join(tmpDir, 'src', 'app.ts'), 'export const value = 2;\n');
    git(tmpDir, ['add', 'src/app.ts']);
    git(tmpDir, ['commit', '-m', 'rewrite app']);
    const rewritten = await measureBlame(tmpDir, sha, 'src/app.ts');
    expect(rewritten.surviving).toBe(0);

    const missing = await measureBlame(tmpDir, sha, 'src/missing.ts');
    expect(missing.skipped).toBe(true);
    expect(missing.reason).toContain('not at HEAD');
    expect(await readRemoteUrl(tmpDir)).toBeNull();
    expect(await readRepoRoot(join(tmpDir, 'src'))).toBe(realpathSync(tmpDir));
    expect(await readBranchesContaining(tmpDir, sha)).toContain('main');
    git(tmpDir, ['branch', 'feature']);
    const membership = await readCommitsOnBranches(tmpDir, ['main', 'feature', '-bad']);
    const listed = await readCommitLog(tmpDir, '2020-01-01T00:00:00Z');
    expect(listed.length).toBeGreaterThan(1);
    for (const commit of listed) {
      expect(membership.get(commit.sha)).toEqual(expect.arrayContaining(['main', 'feature']));
    }
    expect(await readRepoRoot(join(tmpDir, 'missing'))).toBeNull();

    await expect(runAllowedGit(tmpDir, ['status'])).rejects.toBeInstanceOf(GitCommandError);
  });

  it('skips blame for a file over 1 MB', async () => {
    git(tmpDir, ['init', '-b', 'main']);
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'big.ts'), Buffer.alloc(1_048_577, 10));
    git(tmpDir, ['add', 'src/big.ts']);
    git(tmpDir, ['commit', '-m', 'big file']);
    const commits = await readCommitLog(tmpDir, '2020-01-01T00:00:00Z');
    const measured = await measureBlame(tmpDir, commits[0]?.sha ?? '', 'src/big.ts');
    expect(measured.skipped).toBe(true);
    expect(measured.reason).toBe('src/big.ts is over 1 MB');
    expect(measured.surviving).toBe(0);
  });
});
