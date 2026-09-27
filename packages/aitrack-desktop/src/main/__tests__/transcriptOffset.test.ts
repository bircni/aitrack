import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { completeLineOffset, tailHasCompleteLine } from '../transcriptOffset.js';

let directory = '';

afterEach(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
  directory = '';
});

describe('transcript offsets', () => {
  it('stops before a line that is still being written', async () => {
    directory = mkdtempSync(join(tmpdir(), 'aitrack-offset-'));
    const file = join(directory, 'sess.jsonl');
    writeFileSync(file, 'complete\npartial');
    expect(await completeLineOffset(file)).toBe('complete\n'.length);
    expect(await tailHasCompleteLine(file, 'complete\n'.length)).toBe(false);
    writeFileSync(file, 'complete\npartial\n');
    expect(await tailHasCompleteLine(file, 'complete\n'.length)).toBe(true);
    expect(await completeLineOffset(file)).toBe('complete\npartial\n'.length);
  });
});
