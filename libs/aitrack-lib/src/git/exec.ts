import { type ChildProcess, execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomicWrite.js';
import { errorMessage } from '../errors.js';
import { LOCAL_REPO } from '../paths.js';
import { mergeConflictedMachineFile } from '../store/mergeConflict.js';

const MAX_PUSH_ATTEMPTS = 3;

/** Starts the subject of a commit that only adds this machine's usage, the one kind a per-day merge cannot undo. */
export const SYNC_COMMIT_PREFIX = 'sync: ';

/** `windowsHide`: git run from a windowless process (opentrack's worker) otherwise opens a console. `maxBuffer`: `git show` returns whole machine files, past Node's 1 MiB default. */
const GIT_SPAWN_BASE = {
  cwd: LOCAL_REPO,
  windowsHide: true,
  maxBuffer: 256 * 1024 * 1024,
} as const;

/**
 * Sync commits are unattended: a GUI launch lacks the signer on PATH, and a passphrase prompt would hang.
 * Appended, because these variables may already carry the user's config, such as a CI credential helper.
 */
function unsignedEnv(): Record<string, string> {
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  const index = Number.isInteger(count) && count > 0 ? count : 0;
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${String(index)}`]: 'commit.gpgsign',
    [`GIT_CONFIG_VALUE_${String(index)}`]: 'false',
  };
}

export class GitCommandError extends Error {
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

/** A missing cwd is reported as ENOENT too, and that one is the caller's to explain. */
function gitNotFound(error: unknown): Error | null {
  const isMissing = (error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT';
  return isMissing && existsSync(LOCAL_REPO)
    ? new Error('git was not found on PATH; aitrack needs git to sync.')
    : null;
}

export function runGit(args: string[]): string {
  const result = spawnSync('git', args, {
    ...GIT_SPAWN_BASE,
    env: { ...process.env, ...unsignedEnv() },
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const notFound = gitNotFound(result.error);
  if (notFound) throw notFound;
  if (result.status !== 0) throw gitFailure(args, result.status, result.stdout, result.stderr);
  return trimmedText(result.stdout);
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

/** Like `runGit`, but without blocking the event loop. */
export function runGitAsync(args: string[], options: GitOptions = {}): Promise<string> {
  const env = {
    ...process.env,
    ...unsignedEnv(),
    ...(options.timeoutMs === undefined ? {} : NO_PROMPT_ENV),
  };
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
          gitNotFound(error) ??
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

export function isRebaseInProgress(): boolean {
  return (
    existsSync(join(LOCAL_REPO, '.git', 'rebase-merge')) ||
    existsSync(join(LOCAL_REPO, '.git', 'rebase-apply'))
  );
}

/** Best effort: the failure that led here is the one worth reporting. */
export async function abortRebaseIfInProgress(): Promise<void> {
  if (isRebaseInProgress()) await runGitAsync(['rebase', '--abort']).catch(() => undefined);
}

/** One side is absent from a modify/delete conflict, which has no merge. */
function conflictedSide(path: string, stage: 2 | 3): Promise<string | null> {
  return runGitAsync(['show', `:${String(stage)}:${path}`]).catch(() => null);
}

async function resolveConflict(path: string): Promise<void> {
  const remote = /^data\/[^/]+\.json$/u.test(path) ? await conflictedSide(path, 2) : null;
  const local = remote === null ? null : await conflictedSide(path, 3);
  const merged =
    remote === null || local === null
      ? null
      : await mergeConflictedMachineFile(path, remote, local);
  if (merged === null) throw new Error(`${path} cannot be merged automatically`);
  writeFileAtomic(join(LOCAL_REPO, path), merged);
  await runGitAsync(['add', '--', `:(literal)${path}`]);
}

/** `recompute-costs --replace-local` lowers and drops days on purpose, and a merge would bring them back while reporting a push. */
async function assertStoppedOnSyncCommit(): Promise<void> {
  const subject = await runGitAsync(['log', '-1', '--format=%s', 'REBASE_HEAD']).catch(() => '');
  if (!subject.startsWith(SYNC_COMMIT_PREFIX)) {
    throw new Error(`only sync commits merge per day, and this one is "${subject}"`);
  }
}

/** A rebase stops once per conflicting commit, so a branch with several needs several rounds. */
async function resolveRebaseStops(firstStop: unknown): Promise<void> {
  let stop = firstStop;
  while (isRebaseInProgress()) {
    const unmerged = await runGitAsync(['diff', '--name-only', '--diff-filter=U']);
    const paths = unmerged.split('\n').filter((path) => path !== '');
    if (paths.length === 0) throw stop; // Stopped for something other than a conflict.
    await assertStoppedOnSyncCommit();
    for (const path of paths) await resolveConflict(path);
    try {
      await runGitAsync(['-c', 'core.editor=true', 'rebase', '--continue']);
    } catch (error) {
      if (!isRebaseInProgress()) throw error;
      stop = error;
    }
  }
}

/** Replays local commits on the remote. On failure the branch is back as it was, never mid-rebase. */
export async function rebaseOntoRemote(remote: string[], options: GitOptions = {}): Promise<void> {
  try {
    await runGitAsync(['pull', '--rebase', '--quiet', ...remote], options);
  } catch (error) {
    if (!isRebaseInProgress()) throw error;
    try {
      await resolveRebaseStops(error);
    } catch (resolveError) {
      await abortRebaseIfInProgress();
      throw new Error(
        `Could not merge the unpushed data commits with the remote, so they were kept unpushed: ${errorMessage(resolveError)}.\n` +
          `  If a file is unreadable here, set the passphrase or upgrade aitrack. To drop those commits instead: git -C "${LOCAL_REPO}" reset --hard @{upstream}`,
        { cause: resolveError },
      );
    }
  }
}

/** The published `(conflict, options)` form, still honoured for its options; a conflict now merges per day instead. */
interface RetryConflict {
  path: string;
  contents: string;
}

function gitOptionsOf(
  first: GitOptions | RetryConflict | undefined,
  second?: GitOptions,
): GitOptions {
  if (second !== undefined) return second;
  return first === undefined || 'contents' in first ? {} : first;
}

export function pushWithRetry(options?: GitOptions): Promise<void>;
export function pushWithRetry(
  conflict: RetryConflict | undefined,
  options?: GitOptions,
  knownUpstream?: boolean,
): Promise<void>;
export async function pushWithRetry(
  first?: GitOptions | RetryConflict,
  second?: GitOptions,
): Promise<void> {
  const options = gitOptionsOf(first, second);
  const upstream = await hasUpstream();
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
      await rebaseOntoRemote(branch === null ? [] : ['origin', branch], options);
    }
  }
}

export function commitStagedData(message: string, options?: GitOptions): Promise<boolean>;
export function commitStagedData(
  message: string,
  conflict: RetryConflict | undefined,
  options?: GitOptions,
): Promise<boolean>;
export async function commitStagedData(
  message: string,
  first?: GitOptions | RetryConflict,
  second?: GitOptions,
): Promise<boolean> {
  const staged = await runGitAsync(['diff', '--cached', '--name-only', '--', 'data/']);
  if (!staged) return false;

  await runGitAsync(['commit', '-m', message]);
  await pushWithRetry(gitOptionsOf(first, second));
  return true;
}
