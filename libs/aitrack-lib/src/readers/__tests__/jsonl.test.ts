import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { type JsonlFilter, streamJsonlObjects } from '../jsonl.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aitrack-jsonl-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const USAGE_LINES: JsonlFilter = {
  needles: ['"usage"'],
  carry: { needle: '"cwd"', holds: (record) => typeof record.cwd === 'string' },
};

async function collect(lines: string, filter?: JsonlFilter): Promise<unknown[]> {
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, lines);
  const entries = [];
  for await (const entry of streamJsonlObjects(file, filter)) entries.push(entry);
  return entries;
}

it('streams only objects, tolerating bad lines, CRLF and a path that is gone', async () => {
  await expect(
    collect('\n  \n{"n":1}\r\n{truncated\nnull\n42\n[]\n"text"\n{"n":2}\n{"n":3}'),
  ).resolves.toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  const entries = [];
  for await (const entry of streamJsonlObjects(join(dir, 'gone.jsonl'))) entries.push(entry);
  expect(entries).toEqual([]);
});

it('parses only matching lines, with the last carrier before one that lacks the state', async () => {
  const lines = [
    '{"cwd":"/a"}',
    '{"usage":1,"cwd":"/b"}',
    '{"cwd":"/c"}',
    '{"nested":{"cwd":"/n"}}',
    '{bad "cwd" "usage"',
    '{"usage":2}',
    '{"type":"user"}',
    '{"usage":3}',
    '{"cwd":"/d"}',
  ];
  await expect(collect(`${lines.join('\n')}\n`, USAGE_LINES)).resolves.toEqual([
    { usage: 1, cwd: '/b' },
    { cwd: '/c' },
    { usage: 2 },
    { usage: 3 },
  ]);
});

it('carries state across chunks and lines longer than a chunk', async () => {
  const filler = JSON.stringify({ text: 'x'.repeat(5 * 1024 * 1024) });
  const lines = ['{"usage":0,"cwd":"/x"}', '{"cwd":"/y"}', filler, '{"usage":1}', filler];
  await expect(collect(lines.join('\n'), USAGE_LINES)).resolves.toEqual([
    { usage: 0, cwd: '/x' },
    { cwd: '/y' },
    { usage: 1 },
  ]);
});
