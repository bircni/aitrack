import { execSync } from 'node:child_process';
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

import type { MachineFile } from './types.js';
import { parseMachineFile } from './validate.js';

export const LOCAL_REPO = join(homedir(), '.config', 'aitrack', 'repo');
export const PENDING_DATA_DIR = join(homedir(), '.config', 'aitrack', 'pending', 'data');

function git(args: string, opts: Record<string, unknown> = {}): void {
  execSync(`git ${args}`, { cwd: LOCAL_REPO, stdio: 'inherit', ...opts });
}

export function isCloned(): boolean {
  return existsSync(join(LOCAL_REPO, '.git'));
}

export function cloneRepo(url: string): void {
  execSync(`git clone "${url}" "${LOCAL_REPO}"`, { stdio: 'inherit' });
}

export function removeLocalClone(): void {
  if (existsSync(LOCAL_REPO)) {
    rmSync(LOCAL_REPO, { recursive: true, force: true });
  }
}

export function pull(): void {
  const refs = execSync('git ls-remote --heads origin', { cwd: LOCAL_REPO, stdio: 'pipe' })
    .toString()
    .trim();
  if (!refs) return; // empty repo, nothing to pull yet
  git('pull --ff-only --quiet');
}

export function tryPull(opts?: { quiet?: boolean }): void {
  try {
    const refs = execSync('git ls-remote --heads origin', { cwd: LOCAL_REPO, stdio: 'pipe' })
      .toString()
      .trim();
    if (!refs) return;
    if (!opts?.quiet) {
      console.log('Pulling latest from remote...');
    }
    git('pull --ff-only --quiet');
  } catch {
    // Offline or unreachable — continue with the local clone.
  }
}

export function commitAndPush(hostname: string): boolean {
  git('add data/');
  const staged = execSync('git status --porcelain -- data/', { cwd: LOCAL_REPO, stdio: 'pipe' })
    .toString()
    .trim();
  if (!staged) {
    return false; // nothing to commit
  }
  git(`commit -m "sync: ${hostname} at ${new Date().toISOString()}"`, { stdio: 'pipe' });
  try {
    git('push');
  } catch {
    git('push -u origin HEAD'); // first push to empty repo
  }
  return true;
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
  for (const src of pending) {
    copyFileSync(src, join(targetDataDir, basename(src)));
  }
  rmSync(PENDING_DATA_DIR, { recursive: true, force: true });
  return pending.length;
}

export function removePendingMachineFile(machineId: string): void {
  const filePath = join(PENDING_DATA_DIR, `${machineId}.json`);
  if (existsSync(filePath)) rmSync(filePath);
}
