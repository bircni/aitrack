import { existsSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { environmentValue } from '../env.js';
import { isMissingPathError } from '../errors.js';
import type { CheckResult } from '../providers/checkResult.js';
import { mapWithConcurrency } from './concurrency.js';

export function splitConfiguredPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Every `.jsonl` path under `dir`, depth-first in directory-entry order. */
export async function listJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  // Entry order, not completion order: Claude dedup is first-file-wins.
  const perEntry = await mapWithConcurrency(entries, (entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listJsonlFiles(full);
    return Promise.resolve(entry.isFile() && entry.name.endsWith('.jsonl') ? [full] : []);
  });
  return perEntry.flat();
}

/** Every `.jsonl` file under `roots`, de-duplicated: overlapping roots would double its tokens. */
export async function listUniqueSourceFiles(roots: string[]): Promise<string[]> {
  const perRoot = await Promise.all(
    roots.map(async (root) => {
      const [realRoot, files] = await Promise.all([
        realpath(root).catch(() => root),
        listJsonlFiles(root),
      ]);
      return files.map((file) => ({ file, identity: join(realRoot, relative(root, file)) }));
    }),
  );
  const seen = new Set<string>();
  const files: string[] = [];
  for (const { file, identity } of perRoot.flat()) {
    if (seen.has(identity)) continue;
    seen.add(identity);
    // Keep the listed path: realpath rewrites /var to /private/var on macOS, changing cache keys.
    files.push(file);
  }
  return files;
}

export async function jsonlSourceSummary(
  roots: string[],
): Promise<{ existing: string[]; fileCount: number }> {
  const existing = roots.filter((root) => existsSync(root));
  const counts = await Promise.all(
    existing.map((root) => listJsonlFiles(root).then((files) => files.length)),
  );
  return { existing, fileCount: counts.reduce((sum, count) => sum + count, 0) };
}

export async function sourceCheck(label: string, roots: string[]): Promise<CheckResult> {
  const { existing, fileCount } = await jsonlSourceSummary(roots);
  if (fileCount > 0) {
    return {
      status: 'ok',
      label,
      detail: `${String(fileCount)} JSONL file(s) across ${String(existing.length)} existing path(s)`,
    };
  }
  if (existing.length > 0) {
    return {
      status: 'warn',
      label,
      detail: `paths exist but no JSONL files were found: ${existing.join(', ')}`,
    };
  }
  return {
    status: 'warn',
    label,
    detail: `no source paths found; checked ${roots.join(', ')}`,
  };
}

interface HomeDirOptions {
  /**
   * With the tool's env override set, return only that folder: the tool itself
   * reads nothing else, so a login found elsewhere belongs to another account.
   */
  overrideOnly?: boolean;
}

/** Claude Code config directories, highest priority first. */
export function claudeHomeDirs(options: HomeDirOptions = {}): string[] {
  const configDir = environmentValue('CLAUDE_CONFIG_DIR');
  if (configDir && options.overrideOnly) return [configDir];
  const xdg = environmentValue('XDG_CONFIG_HOME');
  return [
    ...(configDir ? [configDir] : []),
    ...(xdg ? [join(xdg, 'claude')] : []),
    join(homedir(), '.config', 'claude'),
    join(homedir(), '.claude'),
  ];
}

/** Codex home directories, highest priority first. */
export function codexHomeDirs(options: HomeDirOptions = {}): string[] {
  const codexHome = environmentValue('CODEX_HOME');
  if (codexHome && options.overrideOnly) return [codexHome];
  return [
    ...(codexHome ? [codexHome] : []),
    join(homedir(), '.codex'),
    join(homedir(), '.config', 'codex'),
  ];
}

/** Mistral Vibe home directory; Vibe reads only `$VIBE_HOME` when it is set. */
export function vibeHomeDir(): string {
  return environmentValue('VIBE_HOME') ?? join(homedir(), '.vibe');
}

export function resolveSourceRoots(options: {
  envValue?: string;
  configValue?: string;
  defaults: string[];
}): string[] {
  const paths = new Set([
    ...splitConfiguredPaths(options.envValue),
    ...splitConfiguredPaths(options.configValue),
    ...options.defaults,
  ]);
  return [...paths].map((p) => resolve(p));
}
