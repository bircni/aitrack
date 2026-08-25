import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { mapWithConcurrency } from './concurrency.js';

export function splitConfiguredPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Every `.jsonl` path under `dir`, depth-first in directory-entry order.
 *
 * Sibling directories are walked concurrently — the walk was sequential inside
 * an otherwise-parallel module. Results are reassembled in entry order rather
 * than completion order: the Claude reader resolves cross-file key collisions
 * by file order, so a nondeterministic listing would make its output depend on
 * disk timing.
 */
async function walkJsonlFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const perEntry = await mapWithConcurrency(entries, (entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walkJsonlFiles(full);
    return Promise.resolve(entry.isFile() && entry.name.endsWith('.jsonl') ? [full] : []);
  });
  return perEntry.flat();
}

/** List every `.jsonl` file under `root` (recursive). */
export function listJsonlFiles(root: string): Promise<string[]> {
  return walkJsonlFiles(root);
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
