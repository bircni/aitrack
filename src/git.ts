import { spawnSync } from 'node:child_process';
import {
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

export const LOCAL_REPO = join(homedir(), '.config', 'aitrack', 'repo');
export const PENDING_DATA_DIR = join(homedir(), '.config', 'aitrack', 'pending', 'data');

function runGit(args: string[], options: { stdio?: 'inherit' | 'pipe' } = {}): string {
  const stdio = options.stdio ?? 'inherit';
  if (stdio === 'pipe') {
    const result = spawnSync('git', args, {
      cwd: LOCAL_REPO,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed with exit code ${String(result.status)}`);
    }
    const stdout = result.stdout;
    return typeof stdout === 'string' ? stdout.trim() : '';
  }

  const result = spawnSync('git', args, { cwd: LOCAL_REPO, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed with exit code ${String(result.status)}`);
  }
  return '';
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

export function pull(): void {
  const references = runGit(['ls-remote', '--heads', 'origin'], { stdio: 'pipe' });
  if (!references) return;
  runGit(['pull', '--ff-only', '--quiet']);
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
  const staged = runGit(['status', '--porcelain', '--', 'data/'], { stdio: 'pipe' });
  if (!staged) {
    return false;
  }
  const result = spawnSync('git', ['commit', '-m', message], {
    cwd: LOCAL_REPO,
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    throw new Error(`git commit failed with exit code ${String(result.status)}`);
  }
  try {
    runGit(['push']);
  } catch {
    runGit(['push', '-u', 'origin', 'HEAD']);
  }
  return true;
}

export function commitAndPush(hostname: string): boolean {
  return commitDataChanges(`sync: ${hostname} at ${new Date().toISOString()}`);
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
  mkdirSync(PENDING_DATA_DIR, { recursive: true });
  const filePath = join(PENDING_DATA_DIR, `${machine.hostname}.json`);
  writeFileSync(filePath, JSON.stringify(machine, null, 2), 'utf8');
}

export function listPendingDataFiles(): string[] {
  if (!existsSync(PENDING_DATA_DIR)) return [];
  return readdirSync(PENDING_DATA_DIR)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => join(PENDING_DATA_DIR, f));
}

export function adoptPendingDataFiles(targetDataDir: string): number {
  const pending = listPendingDataFiles();
  if (pending.length === 0) return 0;
  mkdirSync(targetDataDir, { recursive: true });
  for (const source of pending) {
    copyFileSync(source, join(targetDataDir, basename(source)));
  }
  rmSync(PENDING_DATA_DIR, { recursive: true, force: true });
  return pending.length;
}

export function removePendingMachineFile(machineId: string): void {
  const filePath = join(PENDING_DATA_DIR, `${machineId}.json`);
  if (existsSync(filePath)) rmSync(filePath);
}
