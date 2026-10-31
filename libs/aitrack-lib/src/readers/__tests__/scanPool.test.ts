import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { providerFixture } from '@aitrack/test-fixtures';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { scanClaudeFile } from '../claudeScan.js';
import { scanCodexFile } from '../codexScan.js';
import { ScanPool, scanEach } from '../scanPool.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aitrack-scan-pool-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function workerEntry(body: string): URL {
  const file = join(dir, `${String(Math.random()).slice(2)}.mjs`);
  writeFileSync(file, body);
  return pathToFileURL(file);
}

/** Runs the TypeScript sources in the worker, as the built `.js` runs itself. */
function tsxEntry(): URL {
  const tsx = import.meta.resolve('tsx/esm/api');
  const source = pathToFileURL(join(import.meta.dirname, '../scanPool.ts')).href;
  return workerEntry(
    `const { register } = await import(${JSON.stringify(tsx)});\nregister();\nawait import(${JSON.stringify(source)});`,
  );
}

const claude = providerFixture('claude-session.jsonl');
const codex = providerFixture('codex-session.jsonl');

it('scans in worker threads exactly as in this one', async () => {
  const pool = new ScanPool(tsxEntry(), 2);
  try {
    const [fromClaude, fromCodex, missing] = await Promise.all([
      pool.scan('claude', claude),
      pool.scan('codex', codex),
      pool.scan('claude', join(dir, 'gone.jsonl')),
    ]);
    expect(fromClaude).toEqual(await scanClaudeFile(claude));
    expect(fromCodex).toEqual(await scanCodexFile(codex));
    expect(missing).toEqual([]);
    await expect(pool.scan('codex', dir)).rejects.toThrow('EISDIR');
  } finally {
    await pool.close();
  }
});

it('scans here when a worker cannot start', async () => {
  const pool = new ScanPool(workerEntry('throw new Error("no worker");'), 1);
  const [fromClaude, fromCodex, failed] = await Promise.allSettled([
    pool.scan('claude', claude),
    pool.scan('codex', codex),
    pool.scan('codex', dir),
  ]);
  await pool.close();
  expect(fromClaude).toEqual({ status: 'fulfilled', value: await scanClaudeFile(claude) });
  expect(fromCodex).toEqual({ status: 'fulfilled', value: await scanCodexFile(codex) });
  expect(failed.status).toBe('rejected');
});

it('spreads only a large batch over workers, shared by readers that run at once', async () => {
  const entry = tsxEntry();
  const large = 64 * 1024 * 1024;
  const claudeSources = [{ filePath: claude }, { filePath: claude }];
  const inWorkers = scanEach('claude', claudeSources, large, entry);
  const alsoInWorkers = scanEach('codex', [{ filePath: codex }, { filePath: codex }], large, entry);
  const inThread = scanEach('claude', claudeSources, 1, entry);

  const expected = await scanClaudeFile(claude);
  for (const { source, scan } of [...inWorkers, ...inThread]) {
    expect(source.filePath).toBe(claude);
    expect(await scan()).toEqual(expected);
  }
  for (const { scan } of alsoInWorkers) expect(await scan()).toEqual(await scanCodexFile(codex));
});

it('hands a failed worker’s files to the ones still running', async () => {
  const tsx = tsxEntry().href;
  const pool = new ScanPool(
    workerEntry(
      `import { threadId } from 'node:worker_threads';\nif (threadId % 2 === 0) throw new Error('no worker');\nawait import(${JSON.stringify(tsx)});`,
    ),
    2,
  );
  const scans = await Promise.all(
    [claude, claude, claude, claude].map((file) => pool.scan('claude', file)),
  );
  await pool.close();
  const expected = await scanClaudeFile(claude);
  for (const scan of scans) expect(scan).toEqual(expected);
});
