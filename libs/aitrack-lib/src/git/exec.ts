import { type ChildProcess, execFile, spawnSync } from 'node:child_process';
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

/** Without this, git run from a windowless process (opentrack's worker) opens a console on Windows. */
const GIT_SPAWN_BASE = { cwd: LOCAL_REPO, windowsHide: true } as const;

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

function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** stderr explains a failure better; some git commands only write to stdout. */
function gitFailure(
  args: string[],
  status: number | null,
  stdout: unknown,
  stderr: unknown,
): GitCommandError {
  return new GitCommandError(args, status, trimmedText(stderr) || trimmedText(stdout));
}

export function runGit(args: string[], options: { stdio?: 'inherit' | 'pipe' } = {}): string {
  const stdio = options.stdio ?? 'inherit';
  if (stdio === 'pipe') {
    const result = spawnSync('git', args, {
      ...GIT_SPAWN_BASE,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (result.status !== 0) throw gitFailure(args, result.status, result.stdout, result.stderr);
    return trimmedText(result.stdout);
  }

  const result = spawnSync('git', args, { ...GIT_SPAWN_BASE, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new GitCommandError(args, result.status, '');
  }
  return '';
}

/** Windows needs the whole tree: git's ssh/https helpers otherwise live on. */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    child.kill();
  }
}

/** A timed call runs unattended, so git should fail at a credential prompt instead of waiting. */
const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

/** For the network calls; `timeoutMs` bounds each one, without it they wait on git indefinitely. */
export interface GitOptions {
  timeoutMs?: number;
}

/** Piped like `runGit(..., { stdio: 'pipe' })`, but without blocking the event loop. */
export function runGitAsync(args: string[], options: GitOptions = {}): Promise<string> {
  const env = options.timeoutMs === undefined ? process.env : { ...process.env, ...NO_PROMPT_ENV };
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { ...GIT_SPAWN_BASE, env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        if (!error) {
          resolve(stdout.trim());
          return;
        }
        reject(
          gitFailure(args, typeof error.code === 'number' ? error.code : null, stdout, stderr),
        );
      },
    );
    // Our own clock rather than execFile's: its callback waits for helpers still holding the pipes.
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            killTree(child);
            reject(
              new Error(`git ${args.join(' ')} timed out after ${String(options.timeoutMs)} ms`),
            );
          }, options.timeoutMs);
  });
}

export async function hasUpstream(): Promise<boolean> {
  try {
    await runGitAsync(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    return true;
  } catch {
    return false;
  }
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

async function rebaseForPushRetry(
  conflict: RetryConflict | undefined,
  branch: string | null,
  options: GitOptions,
): Promise<void> {
  try {
    const remote = branch === null ? [] : ['origin', branch];
    await runGitAsync(['pull', '--rebase', '--quiet', ...remote], options);
  } catch (error) {
    const unmerged = await runGitAsync(['diff', '--name-only', '--diff-filter=U']);
    const conflicts = unmerged.split('\n').filter((path) => path !== '');
    if (
      conflict &&
      conflicts.length === 1 &&
      conflicts[0] === conflict.path &&
      isRebaseInProgress()
    ) {
      writeFileSync(join(LOCAL_REPO, conflict.path), conflict.contents, 'utf8');
      await runGitAsync(['add', '--', `:(literal)${conflict.path}`]);
      await runGitAsync(['-c', 'core.editor=true', 'rebase', '--continue']);
      return;
    }
    if (isRebaseInProgress()) {
      try {
        await runGitAsync(['rebase', '--abort']);
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

/** `knownUpstream` saves asking git again when the caller already did. */
export async function pushWithRetry(
  conflict?: RetryConflict,
  options: GitOptions = {},
  knownUpstream?: boolean,
): Promise<void> {
  const upstream = knownUpstream ?? (await hasUpstream());
  const branch = upstream ? null : await runGitAsync(['branch', '--show-current']);
  if (!upstream && branch === '') {
    throw new Error('Cannot push from a detached HEAD without an upstream branch.');
  }
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    try {
      await runGitAsync(upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], options);
      return;
    } catch (error) {
      if (!isNonFastForward(error) || attempt === MAX_PUSH_ATTEMPTS) throw error;
      await rebaseForPushRetry(conflict, branch, options);
    }
  }
}

export async function commitStagedData(
  message: string,
  conflict?: RetryConflict,
  options: GitOptions = {},
): Promise<boolean> {
  const staged = await runGitAsync(['diff', '--cached', '--name-only', '--', 'data/']);
  if (!staged) return false;

  await runGitAsync(['commit', '-m', message]);
  await pushWithRetry(conflict, options);
  return true;
}
