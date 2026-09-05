import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  jsonlSourceSummary,
  listJsonlFiles,
  listUniqueSourceFiles,
  resolveSourceRoots,
  splitConfiguredPaths,
} from '../paths.js';

let root: string;

function write(relativePath: string): string {
  const full = join(root, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '{}\n', 'utf8');
  return full;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'aitrack-paths-'));
  write('a.jsonl');
  write('nested/b.jsonl');
  write('nested/deep/c.jsonl');
  write('nested/notes.txt');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listJsonlFiles', () => {
  it('finds every .jsonl file recursively and ignores other extensions', async () => {
    const files = await listJsonlFiles(root);
    expect(files.map((f) => relative(root, f).replaceAll(sep, '/')).toSorted()).toEqual([
      'a.jsonl',
      'nested/b.jsonl',
      'nested/deep/c.jsonl',
    ]);
  });

  it('returns nothing for a directory that does not exist', async () => {
    expect(await listJsonlFiles(join(root, 'missing'))).toEqual([]);
  });

  it('lists files in a stable order across runs', async () => {
    // Sibling directories are walked concurrently; the Claude reader resolves
    // cross-file key collisions by file order, so completion order must not
    // leak into the listing.
    const first = await listJsonlFiles(root);
    const second = await listJsonlFiles(root);
    expect(second).toEqual(first);
  });
});

describe('listUniqueSourceFiles', () => {
  it('de-duplicates a file reachable from more than one root', async () => {
    // Roots overlap in practice: the env override, the config value and the
    // built-in defaults can all name the same tree, and one can nest inside
    // another. A file counted twice doubles every token it holds.
    const files = await listUniqueSourceFiles([root, join(root, 'nested'), root]);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toHaveLength(3);
  });

  it('keeps roots in the order given', async () => {
    const files = await listUniqueSourceFiles([join(root, 'nested'), root]);
    expect(files[0]).toBe(join(root, 'nested', 'b.jsonl'));
    expect(files).toContain(join(root, 'a.jsonl'));
  });

  it('skips roots that do not exist', async () => {
    expect(await listUniqueSourceFiles([join(root, 'missing')])).toEqual([]);
  });
});

describe('jsonlSourceSummary', () => {
  it('reports only existing roots and the total file count', async () => {
    const summary = await jsonlSourceSummary([root, join(root, 'missing')]);
    expect(summary.existing).toEqual([root]);
    expect(summary.fileCount).toBe(3);
  });
});

describe('splitConfiguredPaths', () => {
  it('splits, trims and drops empty entries', () => {
    expect(splitConfiguredPaths(' /a , /b ,, ')).toEqual(['/a', '/b']);
    expect(splitConfiguredPaths(undefined)).toEqual([]);
    expect(splitConfiguredPaths('')).toEqual([]);
  });
});

describe('resolveSourceRoots', () => {
  it('prefers env over config over defaults and de-duplicates', () => {
    expect(
      resolveSourceRoots({ envValue: '/one,/two', configValue: '/two', defaults: ['/three'] }),
    ).toEqual([resolve('/one'), resolve('/two'), resolve('/three')]);
  });

  it('falls back to the defaults when nothing is configured', () => {
    expect(resolveSourceRoots({ defaults: ['/only'] })).toEqual([resolve('/only')]);
  });
});
