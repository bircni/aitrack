import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ReaderPool, readerPoolSize } from '../workerPool.js';

let directory = '';

afterEach(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
  directory = '';
});

describe('reader pool', () => {
  it('stays within the planned size', () => {
    expect(readerPoolSize()).toBeGreaterThan(0);
    expect(readerPoolSize()).toBeLessThanOrEqual(4);
  });

  it('reads a Claude transcript on a worker', async () => {
    directory = mkdtempSync(join(tmpdir(), 'aitrack-pool-'));
    const file = join(directory, 'sess.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({
        type: 'user',
        timestamp: '2026-09-20T12:00:00.000Z',
        sessionId: 'sess',
        cwd: directory,
        message: { role: 'user', content: 'edit it' },
      })}\n`,
    );
    const pool = new ReaderPool();
    try {
      const result = await pool.read('claude', file);
      expect(result.session.id).toBe('claude:sess');
      expect(result.session.cwd).toBe(directory);
      expect(result.usage?.keys).toEqual([]);
    } finally {
      await pool.close();
    }
  });
});
