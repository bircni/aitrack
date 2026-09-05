import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { errorMessage } from '../errors.js';
import { LOCAL_REPO } from '../paths.js';

/**
 * Running git and surviving a concurrent push.
 *
 * Split out of the old `src/git.ts`, which mixed process invocation with repo
 * lifecycle and with a filesystem store for machine JSON that involved no git
 * at all.
 */
const MAX_PUSH_ATTEMPTS = 3;

class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly status: number | null,
    readonly output: string,
  ) {
    const detail = output === '' ? '' : `: ${output}`;
    super(`git ${args.join(' ')} failed with exit code ${String(status)}${detail}`);
    this.name = 'GitCommandError';
  }
}

export function runGit(args: string[], options: { stdio?: 'inherit' | 'pipe' } = {}): string {
  const stdio = options.stdio ?? 'inherit';
  if (stdio === 'pipe') {
    const result = spawnSync('git', args, {
      cwd: LOCAL_REPO,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
      const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
      throw new GitCommandError(args, result.status, stderr === '' ? stdout : stderr);
    }
    const stdout = result.stdout;
    return typeof stdout === 'string' ? stdout.trim() : '';
  }

  const result = spawnSync('git', args, { cwd: LOCAL_REPO, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new GitCommandError(args, result.status, '');
  }
  return '';
}

export function hasUpstream(): boolean {
  const result = spawnSync(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    {
      cwd: LOCAL_REPO,
      stdio: 'pipe',
      encoding: 'utf8',
    },
  );
  return result.status === 0;
}

function isNonFastForward(error: unknown): error is GitCommandError {
  return (
    error instanceof GitCommandError &&
    /(?:non-fast-forward|fetch first|\[rejected\].*(?:rejected|stale info))/iu.test(error.output)
  );
}

interface RetryConflict {
  path: string;
  contents: string;
}

export function isRebaseInProgress(): boolean {
  return (
    existsSync(join(LOCAL_REPO, '.git', 'rebase-merge')) ||
    existsSync(join(LOCAL_REPO, '.git', 'rebase-apply'))
  );
}

function rebaseForPushRetry(conflict: RetryConflict | undefined, branch: string | null): void {
  try {
    const remote = branch === null ? [] : ['origin', branch];
    runGit(['pull', '--rebase', '--quiet', ...remote], { stdio: 'pipe' });
  } catch (error) {
    const conflicts = runGit(['diff', '--name-only', '--diff-filter=U'], { stdio: 'pipe' })
      .split('\n')
      .filter((path) => path !== '');
    if (
      conflict &&
      conflicts.length === 1 &&
      conflicts[0] === conflict.path &&
      isRebaseInProgress()
    ) {
      writeFileSync(join(LOCAL_REPO, conflict.path), conflict.contents, 'utf8');
      runGit(['add', '--', `:(literal)${conflict.path}`], { stdio: 'pipe' });
      runGit(['-c', 'core.editor=true', 'rebase', '--continue'], { stdio: 'pipe' });
      return;
    }
    if (isRebaseInProgress()) {
      try {
        runGit(['rebase', '--abort'], { stdio: 'pipe' });
      } catch {
        // Preserve the original retry failure below.
      }
    }
    throw new Error(
      `Concurrent sync detected, but the local commit could not be replayed safely. ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function pushWithRetry(conflict?: RetryConflict): void {
  const upstream = hasUpstream();
  const branch = upstream ? null : runGit(['branch', '--show-current'], { stdio: 'pipe' });
  if (!upstream && branch === '') {
    throw new Error('Cannot push from a detached HEAD without an upstream branch.');
  }
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    try {
      runGit(upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], { stdio: 'pipe' });
      return;
    } catch (error) {
      if (!isNonFastForward(error) || attempt === MAX_PUSH_ATTEMPTS) throw error;
      rebaseForPushRetry(conflict, branch);
    }
  }
}

export function commitStagedData(message: string, conflict?: RetryConflict): boolean {
  const staged = runGit(['diff', '--cached', '--name-only', '--', 'data/'], { stdio: 'pipe' });
  if (!staged) return false;

  runGit(['commit', '-m', message], { stdio: 'pipe' });
  pushWithRetry(conflict);
  return true;
}
