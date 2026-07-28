import { spawnSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { MachineFile } from './data/types.js';
import { parseMachineFile } from './data/validate.js';
import { machineDataFilename, normalizeMachineId } from './machineId.js';

export const LOCAL_REPO = join(homedir(), '.config', 'aitrack', 'repo');
export const PENDING_DATA_DIR = join(homedir(), '.config', 'aitrack', 'pending', 'data');
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

function machineFilePath(directory: string, machineId: string): string {
  return join(directory, machineDataFilename(machineId));
}

function runGit(args: string[], options: { stdio?: 'inherit' | 'pipe' } = {}): string {
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

function hasUpstream(): boolean {
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
    /(?:non-fast-forward|fetch first|\[rejected\].*(?:rejected|stale info))/i.test(error.output)
  );
}

interface RetryConflict {
  path: string;
  contents: string;
}

function isRebaseInProgress(): boolean {
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
      `Concurrent sync detected, but the local commit could not be replayed safely. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function pushWithRetry(conflict?: RetryConflict): void {
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

function commitStagedData(message: string, conflict?: RetryConflict): boolean {
  const staged = runGit(['diff', '--cached', '--name-only', '--', 'data/'], { stdio: 'pipe' });
  if (!staged) return false;

  runGit(['commit', '-m', message], { stdio: 'pipe' });
  pushWithRetry(conflict);
  return true;
}

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

export function tryPull(options?: { quiet?: boolean }): void {
  try {
    const references = runGit(['ls-remote', '--heads', 'origin'], { stdio: 'pipe' });
    if (!references) return;
    if (!options?.quiet) {
      console.log('Pulling latest from remote...');
    }
    runGit(['pull', '--ff-only', '--quiet']);
  } catch {
    // Offline or unreachable — continue with the local clone.
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

export function listDataFiles(): string[] {
  const dataDir = join(LOCAL_REPO, 'data');
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => join(dataDir, f));
}

export function readDataFile(filePath: string): MachineFile | null {
  const raw = readFileSync(filePath, 'utf8');
  return parseMachineFile(raw, filePath);
}

export function writePendingMachineFile(machine: MachineFile): void {
  const filePath = machineFilePath(PENDING_DATA_DIR, machine.hostname);
  mkdirSync(PENDING_DATA_DIR, { recursive: true });
  writeFileSync(filePath, JSON.stringify(machine, null, 2), 'utf8');
}

export function listPendingDataFiles(): string[] {
  if (!existsSync(PENDING_DATA_DIR)) return [];
  return readdirSync(PENDING_DATA_DIR)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => join(PENDING_DATA_DIR, f));
}

interface MachineFileMigration {
  source: string;
  target: string;
  sourceContents: string;
  contents: string;
  repositoryPaths?: [string, string];
}

function planMachineFileMigration(
  directory: string,
  previousMachineId: string,
  nextMachineId: string,
): MachineFileMigration | null {
  const source = machineFilePath(directory, previousMachineId);
  if (!existsSync(source)) return null;

  const target = machineFilePath(directory, nextMachineId);
  if (existsSync(target)) {
    throw new Error(
      `Cannot rename machine "${previousMachineId}" to "${nextMachineId}": ${target} already exists.`,
    );
  }

  const sourceContents = readFileSync(source, 'utf8');
  const machine = parseMachineFile(sourceContents, source, {
    allowInconsistentCostTotals: true,
  });
  if (!machine) {
    throw new Error(`Cannot rename machine "${previousMachineId}": ${source} is invalid.`);
  }

  return {
    source,
    target,
    sourceContents,
    contents: JSON.stringify({ ...machine, hostname: nextMachineId }, null, 2),
    repositoryPaths:
      directory === join(LOCAL_REPO, 'data')
        ? [
            `data/${machineDataFilename(previousMachineId)}`,
            `data/${machineDataFilename(nextMachineId)}`,
          ]
        : undefined,
  };
}

function rollbackMachineFileMigration(plan: MachineFileMigration): void {
  writeFileSync(plan.source, plan.sourceContents, { encoding: 'utf8', flag: 'wx' });
  try {
    rmSync(plan.target);
  } catch (error) {
    rmSync(plan.source, { force: true });
    throw error;
  }
}

/** Rename this machine's persisted and pending files without overwriting another machine. */
export function migrateMachineDataFiles(previousId: string, nextId: string): void {
  const previousMachineId = normalizeMachineId(previousId);
  const nextMachineId = normalizeMachineId(nextId);
  if (previousMachineId === nextMachineId) return;

  const plans = [
    planMachineFileMigration(join(LOCAL_REPO, 'data'), previousMachineId, nextMachineId),
    planMachineFileMigration(PENDING_DATA_DIR, previousMachineId, nextMachineId),
  ].filter((plan): plan is MachineFileMigration => plan !== null);

  const completed: MachineFileMigration[] = [];
  try {
    for (const plan of plans) {
      try {
        writeFileSync(plan.target, plan.contents, { encoding: 'utf8', flag: 'wx' });
        rmSync(plan.source);
        completed.push(plan);
      } catch (error) {
        rmSync(plan.target, { force: true });
        throw error;
      }
    }
    for (const plan of plans) {
      if (plan.repositoryPaths === undefined) continue;
      runGit(['add', '--', ...plan.repositoryPaths.map((path) => `:(literal)${path}`)], {
        stdio: 'pipe',
      });
    }
  } catch (error) {
    let rollbackError: unknown;
    for (const plan of completed.reverse()) {
      try {
        rollbackMachineFileMigration(plan);
      } catch (candidate) {
        rollbackError ??= candidate;
      }
    }
    if (rollbackError !== undefined) {
      throw new AggregateError(
        [error, rollbackError],
        'Machine data migration and rollback failed.',
      );
    }
    throw error;
  }
}

export function adoptPendingDataFiles(targetDataDir: string): number {
  const pending = listPendingDataFiles();
  if (pending.length === 0) return 0;
  mkdirSync(targetDataDir, { recursive: true });

  const copies: Array<{ source: string; target: string }> = [];
  const skipped: string[] = [];
  for (const source of pending) {
    const filename = basename(source);
    const machineId = filename.slice(0, -'.json'.length);
    if (normalizeMachineId(machineId) !== machineId) {
      throw new Error(`Cannot adopt pending machine file with an invalid name: ${filename}`);
    }
    const target = machineFilePath(targetDataDir, machineId);
    // The repo already holds synced data for this machine, which supersedes the
    // staged copy. Leave it alone rather than aborting the whole adoption —
    // throwing here used to make init unrecoverable once a stale staged file
    // existed, since init is also the only way to write the config back.
    if (existsSync(target)) {
      skipped.push(filename);
      continue;
    }
    copies.push({ source, target });
  }

  for (const { source, target } of copies) {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    try {
      rmSync(source);
    } catch (error) {
      rmSync(target, { force: true });
      throw error;
    }
  }
  if (skipped.length > 0) {
    // The skipped sources stay put — a synced file for the machine exists, but
    // it is not necessarily a superset of what was staged, so deleting them
    // here could drop history. Name the directory instead: nothing else clears
    // it, so this warning repeats on every init until the user does.
    console.warn(
      `Skipped ${String(skipped.length)} staged data file(s) already synced in the repo: ${skipped.join(', ')}`,
    );
    console.warn(
      `  Kept in ${PENDING_DATA_DIR} — delete them once the synced data looks complete.`,
    );
  } else {
    rmSync(PENDING_DATA_DIR, { recursive: true, force: true });
  }
  return copies.length;
}

export function removePendingMachineFile(machineId: string): void {
  const filePath = machineFilePath(PENDING_DATA_DIR, machineId);
  if (existsSync(filePath)) rmSync(filePath);
}
