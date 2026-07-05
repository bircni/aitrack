import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function splitConfiguredPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function countJsonlFilesUnderRoot(root: string): number {
  if (!existsSync(root)) return 0;
  let count = 0;
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        count++;
      }
    }
  };
  walk(root);
  return count;
}

export function jsonlSourceSummary(roots: string[]): { existing: string[]; fileCount: number } {
  const existing = roots.filter((root) => existsSync(root));
  const fileCount = existing.reduce((sum, root) => sum + countJsonlFilesUnderRoot(root), 0);
  return { existing, fileCount };
}
