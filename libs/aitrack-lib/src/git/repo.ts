import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { machineDataFilename, normalizeMachineId } from '../machineId.js';
import { LOCAL_REPO } from '../paths.js';
import {
  commitStagedData,
  GitCommandError,
  type GitOptions,
  hasUpstream,
  isRebaseInProgress,
  pushWithRetry,
  runGit,
  runGitAsync,
} from './exec.js';
import { withRepoLock } from './lock.js';

/** Clone, pull and push the data repo. */
export function isCloned(): boolean {
  return existsSync(join(LOCAL_REPO, '.git'));
}

export function cloneRepo(url: string): void {
  const result = spawnSync('git', ['clone', '--', url, LOCAL_REPO], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git clone failed with exit code ${String(result.status)}`);
  }
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
    if (!(await hasUpstream()) || !(await isAheadOfUpstream())) return false;
    await pushWithRetry(undefined, options, true);
    return true;
  });
}

export function pull(options: GitOptions = {}): Promise<void> {
  return withRepoLock(async () => {
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
      try {
        await runGitAsync(['pull', '--rebase', '--quiet'], options);
      } catch (rebaseError) {
        if (isRebaseInProgress()) {
          try {
            await runGitAsync(['rebase', '--abort']);
          } catch {
            // Preserve the rebase failure below.
          }
        }
        throw rebaseError;
      }
    }
  });
}

export function commitDataChanges(message: string): Promise<boolean> {
  return withRepoLock(async () => {
    await runGitAsync(['add', 'data/']);
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
  // Staged change may be a deletion.
  const absolute = join(LOCAL_REPO, path);
  const conflict = existsSync(absolute)
    ? { path, contents: readFileSync(absolute, 'utf8') }
    : undefined;
  return commitStagedData(`sync: ${machineId} at ${new Date().toISOString()}`, conflict, options);
}

/** Whether this machine's target file is modified, renamed, or untracked in the data repo. */
export async function hasMachineDataChanges(machineId: string): Promise<boolean> {
  const filePath = `:(literal)data/${machineDataFilename(machineId)}`;
  const status = await runGitAsync(['status', '--porcelain', '--', filePath]);
  return status.length > 0;
}
