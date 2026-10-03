import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { streamJsonlObjects } from '../jsonl.js';

it('streams only objects while tolerating blank, malformed and scalar lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitrack-jsonl-'));
  try {
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, '\n  \n{"n":1}\n{truncated\nnull\n42\n[]\n"text"\n{"n":2}\n');
    const entries = [];
    for await (const entry of streamJsonlObjects(file)) entries.push(entry);
    expect(entries).toEqual([{ n: 1 }, { n: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
