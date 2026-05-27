import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { MachineFile } from './types.js';
import { parseMachineFile } from './validate.js';

export const LOCAL_REPO = join(homedir(), '.config', 'aitrack', 'repo');

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
