import { mkdtempSync, mkdirSync, rmSync, writeFileSync, type WatchListener } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchSourceRoots } from '../watcher.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (
      filename: string,
      options?: { recursive?: boolean } | WatchListener<string>,
      listener?: WatchListener<string>,
    ) => {
      if (typeof options === 'function') return actual.watch(filename, options);
      if (options?.recursive === true) throw new Error('recursive watch is unavailable');
      if (listener === undefined) return actual.watch(filename, options);
      return actual.watch(filename, options, listener);
    },
  };
});

let directory = '';

afterEach(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
  directory = '';
});

describe('per-directory watchers', () => {
  it('watches each directory when recursive watch is unavailable', async () => {
    directory = mkdtempSync(join(tmpdir(), 'aitrack-watch-linux-'));
    mkdirSync(join(directory, 'nested'));
    let seen = 0;
    const watchers = watchSourceRoots(
      [directory],
      () => {
        seen += 1;
      },
      30,
    );
    expect(watchers.length).toBeGreaterThan(1);
    await delay(50);
    writeFileSync(join(directory, 'nested', 'sess.jsonl'), '{}\n');
    await delay(250);
    for (const watcher of watchers) watcher.close();
    expect(seen).toBeGreaterThan(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
