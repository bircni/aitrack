import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ParsedCommit } from '../types.js';
import { GitCommandError, assertAllowedGitArgs } from './allow.js';
import { GIT_LOG_FORMAT, countAttributedLines, parseBranchList, parseGitLog } from './parse.js';

function execGit(repo: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repo, ...args],
      { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', timeout: 60_000 },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error('git failed'));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

const BLAME_LINE_CAP = 20_000;
const BLAME_BYTE_CAP = 1_048_576;

export interface BlameMeasurement {
  surviving: number;
  skipped: boolean;
  reason: string | null;
}

/**
 * Run one allow-listed git command in `repo`. Anything outside the list throws
 * before the process is spawned.
 */
export async function runAllowedGit(repo: string, args: readonly string[]): Promise<string> {
  assertAllowedGitArgs(args);
  try {
    return await execGit(repo, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'git failed';
    throw new GitCommandError(message);
  }
}

export async function readRepoRoot(cwd: string): Promise<string | null> {
  try {
    const output = await runAllowedGit(cwd, ['rev-parse', '--show-toplevel']);
    const root = output.trim();
    return root === '' ? null : root;
  } catch {
    return null;
  }
}

export async function readRemoteUrl(root: string): Promise<string | null> {
  try {
    const output = await runAllowedGit(root, ['remote', 'get-url', 'origin']);
    const url = output.trim();
    return url === '' ? null : url;
  } catch {
    return null;
  }
}

/**
 * Branch names that reach each commit.
 *
 * `git log --source` records the ref used to walk to that commit, so a commit
 * on `main` is labelled even when the branch tip is a later commit. Decorations
 * (`%D`) only name the tip itself.
 */
export async function readCommitRefs(root: string): Promise<Map<string, string[]>> {
  const output = await runAllowedGit(root, ['log', '--all', '--source', '--format=%H%x1f%S']);
  const refs = new Map<string, string[]>();
  for (const line of output.split('\n')) {
    const splitAt = line.indexOf('\u001F');
    if (splitAt <= 0) continue;
    const sha = line.slice(0, splitAt);
    const source = line.slice(splitAt + 1).trim();
    const name = branchName(source);
    if (name === null) continue;
    const current = refs.get(sha) ?? [];
    if (!current.includes(name)) current.push(name);
    refs.set(sha, current);
  }
  return refs;
}

function branchName(source: string): string | null {
  if (source === '') return null;
  const withoutRemote = source
    .replace(/^refs\/remotes\/[^/]+\//u, '')
    .replace(/^refs\/heads\//u, '');
  const slash = withoutRemote.lastIndexOf('/');
  const name = slash === -1 ? withoutRemote : withoutRemote.slice(slash + 1);
  return name === '' || name === 'HEAD' ? null : name;
}

export async function readCommitLog(root: string, sinceIso: string): Promise<ParsedCommit[]> {
  const output = await runAllowedGit(root, [
    'log',
    '--all',
    `--since=${sinceIso}`,
    '--numstat',
    `--format=${GIT_LOG_FORMAT}`,
  ]);
  return parseGitLog(output);
}

/**
 * Commits reachable from each branch the sessions used.
 *
 * `git branch --contains <sha>` is the membership test. Walking `git log` on
 * those branch names is the same test from the other side, so a commit on
 * both main and a feature branch is listed under both.
 */
export async function readCommitsOnBranches(
  root: string,
  branchNames: readonly string[],
): Promise<Map<string, string[]>> {
  const refs = new Map<string, string[]>();
  for (const name of branchNames) {
    if (!safeBranchName(name)) continue;
    let output = '';
    try {
      output = await runAllowedGit(root, ['log', name, '--format=%H']);
    } catch {
      continue;
    }
    for (const line of output.split('\n')) {
      const sha = line.trim();
      if (sha.length < 7) continue;
      const current = refs.get(sha) ?? [];
      if (!current.includes(name)) current.push(name);
      refs.set(sha, current);
    }
  }
  return refs;
}

function safeBranchName(name: string): boolean {
  return name !== '' && !name.startsWith('-') && !name.includes('\0') && !/\s/u.test(name);
}

export async function readBranchesContaining(root: string, sha: string): Promise<string[]> {
  try {
    const output = await runAllowedGit(root, ['branch', '--all', '--contains', sha]);
    return parseBranchList(output);
  } catch {
    return [];
  }
}

/**
 * How many of `sha`'s added lines are still that commit's at HEAD.
 *
 * Files that no longer exist, files over 1 MB, or blame output over 20k lines
 * are skipped and the reason is returned so the metric can say why.
 */
export async function measureBlame(
  root: string,
  sha: string,
  filePath: string,
): Promise<BlameMeasurement> {
  try {
    const info = await stat(join(root, filePath));
    if (info.size > BLAME_BYTE_CAP) {
      return { surviving: 0, skipped: true, reason: `${filePath} is over 1 MB` };
    }
  } catch {
    return { surviving: 0, skipped: true, reason: `${filePath} is not at HEAD` };
  }
  try {
    const output = await runAllowedGit(root, ['blame', '--line-porcelain', 'HEAD', '--', filePath]);
    const lines = output.split('\n').length;
    if (lines > BLAME_LINE_CAP) {
      return {
        surviving: 0,
        skipped: true,
        reason: `${filePath} is over ${String(BLAME_LINE_CAP)} lines`,
      };
    }
    return { surviving: countAttributedLines(output, sha), skipped: false, reason: null };
  } catch {
    return { surviving: 0, skipped: true, reason: `${filePath} is not at HEAD` };
  }
}
