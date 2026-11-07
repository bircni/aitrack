import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { providerFixture } from '@aitrack/test-fixtures';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

const inFlight = vi.hoisted(() => ({ now: 0, peak: 0 }));

vi.mock('../claudeScan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claudeScan.js')>();
  return {
    ...actual,
    scanClaudeFile: async (filePath: string) => {
      inFlight.peak = Math.max(inFlight.peak, ++inFlight.now);
      try {
        return await actual.scanClaudeFile(filePath);
      } finally {
        inFlight.now--;
      }
    },
  };
});

import { scanClaudeFile } from '../claudeScan.js';
import { scanCodexFile } from '../codexScan.js';
import { ScanPool, scanEach, scanWorkerEntry } from '../scanPool.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aitrack-scan-pool-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function workerEntry(body: string): URL {
  const file = join(dir, `${String(Math.random()).slice(2)}.mjs`);
  writeFileSync(file, body);
  return pathToFileURL(file);
}

/** Runs the TypeScript sources in the worker, as the built `.js` does. */
function tsxEntry(): URL {
  const tsx = import.meta.resolve('tsx/esm/api');
  const source = pathToFileURL(join(import.meta.dirname, '../scanWorker.ts')).href;
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

it('also takes the files back from a worker that exits without an error', async () => {
  const pool = new ScanPool(workerEntry('process.exit(0);'), 1);
  const expected = await scanClaudeFile(claude);
  await expect(pool.scan('claude', claude)).resolves.toEqual(expected);
  await expect(pool.scan('claude', claude)).resolves.toEqual(expected);
  await pool.close();
});

it('scans here when no worker can even be constructed', async () => {
  const pool = new ScanPool(new URL('https://example.invalid/worker.js'), 2);
  await expect(pool.scan('claude', claude)).resolves.toEqual(await scanClaudeFile(claude));
  await pool.close();
});

it('keeps the usual limit on open files once the last worker has failed', async () => {
  const pool = new ScanPool(workerEntry('throw new Error("no worker");'), 1);
  inFlight.peak = 0;
  const scans = await Promise.all(Array.from({ length: 40 }, () => pool.scan('claude', claude)));
  await pool.close();
  expect(scans).toHaveLength(40);
  expect(inFlight.peak).toBeLessThanOrEqual(8);
  expect(inFlight.peak).toBeGreaterThan(1);
});

it('spreads only a batch worth two workers over them, shared by readers that run at once', async () => {
  const scan = vi.spyOn(ScanPool.prototype, 'scan');
  const close = vi.spyOn(ScanPool.prototype, 'close');
  const entry = tsxEntry();
  const large = 64 * 1024 * 1024;
  const claudeSources = [{ filePath: claude }, { filePath: claude }];
  const inThread = [
    ...scanEach('claude', claudeSources, 1, entry),
    ...scanEach('claude', claudeSources, 40 * 1024 * 1024, entry),
    ...scanEach('claude', [{ filePath: claude }], large, entry),
  ];
  expect(scan).not.toHaveBeenCalled();

  const inWorkers = scanEach('claude', claudeSources, large, entry);
  const alsoInWorkers = scanEach('codex', [{ filePath: codex }, { filePath: codex }], large, entry);
  expect(scan).toHaveBeenCalledTimes(4);

  const expected = await scanClaudeFile(claude);
  for (const { source, scan: run } of [...inWorkers, ...inThread]) {
    expect(source.filePath).toBe(claude);
    expect(await run()).toEqual(expected);
  }
  for (const { scan: run } of alsoInWorkers)
    expect(await run()).toEqual(await scanCodexFile(codex));
  await vi.waitFor(() => {
    expect(close).toHaveBeenCalledTimes(1);
  });
});

it('finds the worker file only beside this module, never by running a bundle', () => {
  const beside = join(dir, 'installed');
  const bundled = join(dir, 'bundled');
  for (const folder of [beside, bundled]) mkdirSync(folder);
  writeFileSync(join(beside, 'scanWorker.js'), '');
  writeFileSync(join(bundled, 'app.js'), '');

  expect(scanWorkerEntry(pathToFileURL(join(beside, 'scanPool.js')).href)).toEqual(
    pathToFileURL(join(beside, 'scanWorker.js')),
  );
  expect(scanWorkerEntry(pathToFileURL(join(bundled, 'app.js')).href)).toBeUndefined();
  expect(scanWorkerEntry(undefined)).toBeUndefined();
  expect(scanWorkerEntry('data:text/javascript,0')).toBeUndefined();
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
