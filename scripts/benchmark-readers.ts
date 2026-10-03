import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(join(os.tmpdir(), 'aitrack-benchmark-'));
const originalHome = os.homedir;
const originalStream = fs.createReadStream;
const originalRead = fs.readFileSync;
const originalStat = promises.stat;
const originalRealpath = promises.realpath;
const originalReaddir = promises.readdir;
let streams = 0;
let metadata = 0;
let cacheReads = 0;
let bytes = 0;
os.homedir = () => dir;
fs.createReadStream = (...args: Parameters<typeof originalStream>) => {
  streams++;
  const stream = originalStream(...args);
  stream.on('data', (chunk: string | Buffer) => {
    bytes += Buffer.byteLength(chunk);
  });
  return stream;
};
fs.readFileSync = ((...args: Parameters<typeof originalRead>) => {
  cacheReads++;
  return originalRead(...args);
}) as typeof originalRead;
promises.stat = ((...args: Parameters<typeof originalStat>) => {
  metadata++;
  return originalStat(...args);
}) as typeof originalStat;
promises.realpath = ((...args: Parameters<typeof originalRealpath>) => {
  metadata++;
  return originalRealpath(...args);
}) as typeof originalRealpath;
promises.readdir = ((...args: Parameters<typeof originalReaddir>) => {
  metadata++;
  return originalReaddir(...args);
}) as typeof originalReaddir;
syncBuiltinESMExports();

function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}
function reset(): void {
  streams = 0;
  metadata = 0;
  cacheReads = 0;
  bytes = 0;
}

try {
  const sourceRoot = process.env.AITRACK_BENCH_ROOT ?? join(import.meta.dirname, '..');
  const readers = pathToFileURL(join(sourceRoot, 'libs/aitrack-lib/src/readers'));
  const { readClaudeData } = (await import(
    `${readers.href}/claude.ts`
  )) as typeof import('../libs/aitrack-lib/src/readers/claude.js');
  const { listUniqueSourceFiles } = (await import(
    `${readers.href}/paths.ts`
  )) as typeof import('../libs/aitrack-lib/src/readers/paths.js');
  const results = [];
  for (const overlap of [false, true]) {
    const root = join(dir, overlap ? 'overlap' : 'unique');
    fs.mkdirSync(root);
    process.env.AITRACK_CLAUDE_PROJECTS_DIRS = root;
    for (let file = 0; file < 100; file++) {
      const rows = Array.from({ length: 100 }, (_, message) => {
        const id = overlap && message < 80 ? message : file * 100 + message;
        return JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-15T12:00:00Z',
          requestId: `r-${String(id)}`,
          message: {
            id: `m-${String(id)}`,
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 100, output_tokens: 25 },
          },
        });
      });
      fs.writeFileSync(
        join(root, `${String(file).padStart(3, '0')}.jsonl`),
        `${rows.join('\n')}\n`,
      );
    }
    const cold = [];
    const warm = [];
    let reference = '';
    let tokens = 0;
    let coldCounts = {};
    let warmCounts = {};
    for (let run = 0; run < 5; run++) {
      fs.rmSync(join(dir, '.config/aitrack/cache'), { recursive: true, force: true });
      reset();
      const start = performance.now();
      const data = await readClaudeData();
      cold.push(performance.now() - start);
      coldCounts = { streams, metadata, cacheReads, bytes, requests: 0 };
      reference = JSON.stringify([...data]);
      tokens = [...data.values()].reduce((sum, day) => sum + day.inputTokens + day.outputTokens, 0);
    }
    for (let run = 0; run < 5; run++) {
      reset();
      const start = performance.now();
      const data = await readClaudeData();
      warm.push(performance.now() - start);
      warmCounts = { streams, metadata, cacheReads, bytes, requests: 0 };
      assert.equal(
        JSON.stringify([...data]),
        reference,
        'warm totals and ordering must match cold',
      );
    }
    assert.equal(tokens, overlap ? 260_000 : 1_250_000);
    results.push({
      corpus: overlap ? 'overlap' : 'unique',
      tokens,
      coldMs: median(cold),
      warmMs: median(warm),
      coldCounts,
      warmCounts,
      cacheBytes: fs.statSync(join(dir, '.config/aitrack/cache/claude.json')).size,
      ...process.memoryUsage(),
    });
  }
  const listingRoot = join(dir, 'listing');
  fs.mkdirSync(listingRoot);
  for (let file = 0; file < 10_000; file++)
    fs.writeFileSync(join(listingRoot, `${String(file).padStart(5, '0')}.jsonl`), '');
  const timings = [];
  let calls = 0;
  for (let run = 0; run < 5; run++) {
    reset();
    const start = performance.now();
    const files = await listUniqueSourceFiles([listingRoot]);
    timings.push(performance.now() - start);
    calls = metadata;
    assert.equal(files.length, 10_000);
    assert.equal(files[0], join(listingRoot, '00000.jsonl'));
    assert.equal(files.at(-1), join(listingRoot, '09999.jsonl'));
  }
  console.log(
    JSON.stringify(
      {
        platform: `${os.platform()} ${os.arch()}`,
        node: process.version,
        runs: 5,
        files: 100,
        messagesPerFile: 100,
        results,
        listing: { files: 10_000, medianMs: median(timings), metadataCalls: calls },
        ...process.memoryUsage(),
      },
      null,
      2,
    ),
  );
} finally {
  os.homedir = originalHome;
  fs.createReadStream = originalStream;
  fs.readFileSync = originalRead;
  promises.stat = originalStat;
  promises.realpath = originalRealpath;
  promises.readdir = originalReaddir;
  syncBuiltinESMExports();
  fs.rmSync(dir, { recursive: true, force: true });
}
