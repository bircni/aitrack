import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { watchSourceRoots } from '../watcher.js';

let directory = '';

afterEach(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
  directory = '';
});

describe('source watchers', () => {
  it('ignores a root that is not there', () => {
    directory = mkdtempSync(join(tmpdir(), 'aitrack-watch-'));
    expect(watchSourceRoots([join(directory, 'missing')], () => undefined, 20)).toEqual([]);
  });

  it('reports a file added under the root', async () => {
    directory = mkdtempSync(join(tmpdir(), 'aitrack-watch-'));
    mkdirSync(join(directory, 'nested'));
    let seen = 0;
    const watchers = watchSourceRoots(
      [directory],
      () => {
        seen += 1;
      },
      30,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    writeFileSync(join(directory, 'nested', 'sess.jsonl'), '{}\n');
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    for (const watcher of watchers) watcher.close();
    expect(seen).toBeGreaterThan(0);
  });

  it('lets a quiet file through while another file is still being written', async () => {
    directory = mkdtempSync(join(tmpdir(), 'aitrack-watch-'));
    mkdirSync(join(directory, 'quiet'));
    mkdirSync(join(directory, 'busy'));
    let seen = 0;
    const watchers = watchSourceRoots(
      [directory],
      () => {
        seen += 1;
      },
      80,
    );
    await delay(40);
    writeFileSync(join(directory, 'quiet', 'one.jsonl'), '{}\n');
    await delay(20);
    for (let step = 0; step < 5; step += 1) {
      writeFileSync(join(directory, 'busy', 'two.jsonl'), `${String(step)}\n`);
      await delay(30);
    }
    for (const watcher of watchers) watcher.close();
    expect(seen).toBeGreaterThan(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
