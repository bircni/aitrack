import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function splitConfiguredPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

async function walkJsonlFiles(dir: string, files: string[]): Promise<void> {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonlFiles(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
}

/** List every `.jsonl` file under `root` (recursive). */
export async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walkJsonlFiles(root, files);
  return files;
}

/**
 * Every `.jsonl` file under any of `roots`, de-duplicated and in root order.
 *
 * Roots can overlap — the same directory can arrive from the env override, the
 * config value and the built-in defaults, and one can nest inside another — and
 * a file listed twice would double every token it holds.
 */
export async function listUniqueSourceFiles(roots: string[]): Promise<string[]> {
  const perRoot = await Promise.all(roots.map((root) => listJsonlFiles(root)));
  const seen = new Set<string>();
  return perRoot.flat().filter((file) => {
    if (seen.has(file)) return false;
    seen.add(file);
    return true;
  });
}

export async function jsonlSourceSummary(
  roots: string[],
): Promise<{ existing: string[]; fileCount: number }> {
  const existing = roots.filter((root) => existsSync(root));
  const counts = await Promise.all(
    existing.map(async (root) => (await listJsonlFiles(root)).length),
  );
  return { existing, fileCount: counts.reduce((sum, count) => sum + count, 0) };
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
