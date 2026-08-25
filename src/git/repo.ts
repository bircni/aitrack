import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { machineDataFilename, normalizeMachineId } from '../machineId.js';
import { LOCAL_REPO } from '../paths.js';
import {
  commitStagedData,
  hasUpstream,
  isRebaseInProgress,
  pushWithRetry,
  runGit,
} from './exec.js';

/** Clone, pull and push the data repo. */
export function isCloned(): boolean {
  return existsSync(join(LOCAL_REPO, '.git'));
}

export function cloneRepo(url: string): void {
  const result = spawnSync('git', ['clone', url, LOCAL_REPO], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git clone failed with exit code ${String(result.status)}`);
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
export function hasUnpushedCommits(): boolean {
  try {
    if (!hasUpstream()) return false;
    return runGit(['rev-list', '--count', '@{upstream}..HEAD'], { stdio: 'pipe' }) !== '0';
  } catch {
    // No upstream ref, or a fresh repo with no commits — nothing to retry.
    return false;
  }
}

/** Push commits that were already made locally. False when there are none. */
export function pushPendingCommits(): boolean {
  if (!hasUnpushedCommits()) return false;
  pushWithRetry();
  return true;
}

export function pull(): void {
  const references = runGit(['ls-remote', '--heads', 'origin'], { stdio: 'pipe' });
  if (!references) return;
  try {
    runGit(['pull', '--ff-only', '--quiet']);
  } catch (error) {
    // An earlier push that failed leaves the branch diverged once the remote
    // moves on, and --ff-only cannot resolve that. Replay the local commits on
    // top of the remote instead of failing every future sync.
    if (!hasUnpushedCommits()) throw error;
    try {
      runGit(['pull', '--rebase', '--quiet'], { stdio: 'pipe' });
    } catch (rebaseError) {
      if (isRebaseInProgress()) {
        try {
          runGit(['rebase', '--abort'], { stdio: 'pipe' });
        } catch {
          // Preserve the rebase failure below.
        }
      }
      throw rebaseError;
    }
  }
}

export function commitDataChanges(message: string): boolean {
  runGit(['add', 'data/']);
  return commitStagedData(message);
}

export function commitAndPush(hostname: string): boolean {
  const machineId = normalizeMachineId(hostname);
  const path = `data/${machineDataFilename(machineId)}`;
  runGit(['add', '--', `:(literal)${path}`]);
  // The staged change can be a deletion (the user cleared their history), in
  // which case there is nothing to read back and nothing to replay on a
  // push-retry conflict. Reading unconditionally aborted the sync with a raw
  // ENOENT instead of committing the deletion.
  const absolute = join(LOCAL_REPO, path);
  const conflict = existsSync(absolute)
    ? { path, contents: readFileSync(absolute, 'utf8') }
    : undefined;
  return commitStagedData(`sync: ${machineId} at ${new Date().toISOString()}`, conflict);
}

/** Whether this machine's target file is modified, renamed, or untracked in the data repo. */
export function hasMachineDataChanges(machineId: string): boolean {
  const filePath = `:(literal)data/${machineDataFilename(machineId)}`;
  return runGit(['status', '--porcelain', '--', filePath], { stdio: 'pipe' }).length > 0;
}
