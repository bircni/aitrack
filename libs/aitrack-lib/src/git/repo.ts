import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { machineDataFilename, normalizeMachineId } from '../machineId.js';
import { LOCAL_REPO } from '../paths.js';
import {
  abortRebaseIfInProgress,
  commitStagedData,
  GitCommandError,
  type GitOptions,
  hasUpstream,
  pushWithRetry,
  rebaseOntoRemote,
  runGit,
  runGitAsync,
  SYNC_COMMIT_PREFIX,
} from './exec.js';
import { withRepoLock } from './lock.js';

export function isCloned(): boolean {
  return existsSync(join(LOCAL_REPO, '.git'));
}

export function cloneRepo(url: string, target = LOCAL_REPO): void {
  const result = spawnSync('git', ['clone', '--', url, target], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git clone failed with exit code ${String(result.status)}`);
  }
}

/** Swaps in a clone of `url` only once it succeeded: the old clone may hold the only copy of unpushed commits. */
export function replaceLocalClone(url: string): void {
  const incoming = `${LOCAL_REPO}.incoming`;
  rmSync(incoming, { recursive: true, force: true });
  try {
    cloneRepo(url, incoming);
    removeLocalClone();
    renameSync(incoming, LOCAL_REPO);
  } catch (error) {
    rmSync(incoming, { recursive: true, force: true });
    throw error;
  }
}

/** A file as of the last commit, or null when it has none. */
export function readCommittedFile(repoPath: string): Promise<string | null> {
  return runGitAsync(['show', `HEAD:${repoPath}`]).catch(() => null);
}

/** The URL as stored, which outlives a deleted or corrupt config; `get-url` would apply insteadOf rewrites. */
export function cloneOriginUrl(): string | null {
  try {
    return runGit(['config', '--get', 'remote.origin.url']);
  } catch {
    return null;
  }
}

export function removeLocalClone(): void {
  if (existsSync(LOCAL_REPO)) {
    rmSync(LOCAL_REPO, { recursive: true, force: true });
  }
}

/**
 * Whether the local branch holds commits the remote does not have yet.
 *
 * A push that fails (offline, auth, rejected) still leaves the commit behind
 * with a clean working tree, so a working-tree check alone would never notice
 * that the data has not actually reached the remote.
 */
export async function hasUnpushedCommits(): Promise<boolean> {
  return (await hasUpstream()) && isAheadOfUpstream();
}

/** Only meaningful once an upstream is known to exist. */
async function isAheadOfUpstream(): Promise<boolean> {
  try {
    return (await runGitAsync(['rev-list', '--count', '@{upstream}..HEAD'])) !== '0';
  } catch {
    // A fresh repo with no commits — nothing to retry.
    return false;
  }
}

/** Push commits that were already made locally. False when there are none. */
export function pushPendingCommits(options: GitOptions = {}): Promise<boolean> {
  return withRepoLock(async () => {
    if (!(await hasUnpushedCommits())) return false;
    await pushWithRetry(options);
    return true;
  });
}

export function pull(options: GitOptions = {}): Promise<void> {
  return withRepoLock(async () => {
    await abortRebaseIfInProgress(); // A dead process's rebase would fail everything below, on every run.
    try {
      await runGitAsync(['pull', '--ff-only', '--quiet'], options);
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error; // A timeout says nothing about an empty remote.
      const heads = await runGitAsync(['ls-remote', '--heads', 'origin'], options).catch(() => {
        throw error;
      });
      if (!heads) return; // Empty remote: nothing to pull yet.
      // An earlier push that failed leaves the branch diverged once the remote
      // moves on, and --ff-only cannot resolve that. Replay the local commits on
      // top of the remote instead of failing every future sync.
      if (!(await hasUnpushedCommits())) throw error;
      await rebaseOntoRemote([], options);
    }
  });
}

/** `paths` limits it to files the caller wrote and checked; a dirty or leftover file beside them stays out. */
export function commitDataChanges(message: string, paths?: readonly string[]): Promise<boolean> {
  return withRepoLock(async () => {
    const pathspecs = paths?.map((path) => `:(literal)${path}`) ?? ['data/'];
    await runGitAsync(['add', '--', ...pathspecs]);
    return commitStagedData(message);
  });
}

export function commitAndPush(hostname: string, options: GitOptions = {}): Promise<boolean> {
  return withRepoLock(() => stageAndPushMachine(hostname, options));
}

async function stageAndPushMachine(hostname: string, options: GitOptions): Promise<boolean> {
  const machineId = normalizeMachineId(hostname);
  const path = `data/${machineDataFilename(machineId)}`;
  await runGitAsync(['add', '--', `:(literal)${path}`]);
  return commitStagedData(
    `${SYNC_COMMIT_PREFIX}${machineId} at ${new Date().toISOString()}`,
    options,
  );
}

/** Whether this machine's target file is modified, renamed, or untracked in the data repo. */
export async function hasMachineDataChanges(machineId: string): Promise<boolean> {
  const filePath = `:(literal)data/${machineDataFilename(machineId)}`;
  const status = await runGitAsync(['status', '--porcelain', '--', filePath]);
  return status.length > 0;
}
