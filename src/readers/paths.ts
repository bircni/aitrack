import { existsSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function splitConfiguredPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function walkJsonlFilesSync(dir: string, files: string[]): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFilesSync(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
}

async function walkJsonlFilesAsync(dir: string, files: string[]): Promise<void> {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonlFilesAsync(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
}

/** List every `.jsonl` file under `root` (recursive). */
export function listJsonlFilesSync(root: string): string[] {
  const files: string[] = [];
  walkJsonlFilesSync(root, files);
  return files;
}

/** List every `.jsonl` file under `root` (recursive). */
export async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walkJsonlFilesAsync(root, files);
  return files;
}

export function jsonlSourceSummary(roots: string[]): { existing: string[]; fileCount: number } {
  const existing = roots.filter((root) => existsSync(root));
  const fileCount = existing.reduce((sum, root) => sum + listJsonlFilesSync(root).length, 0);
  return { existing, fileCount };
}

export function resolveSourceRoots(options: {
  envValue?: string;
  configValue?: string;
  defaults: string[];
}): string[] {
  const paths = new Set<string>(splitConfiguredPaths(options.envValue));
  for (const path of splitConfiguredPaths(options.configValue)) {
    paths.add(path);
  }
  for (const path of options.defaults) {
    paths.add(path);
  }
  return [...paths].map((p) => resolve(p));
}
