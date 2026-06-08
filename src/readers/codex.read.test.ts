import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${tmp}/aitrack-codex-read-test`;
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { readCodexData } from './codex.js';

function jsonl(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
}

describe('readCodexData', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('walks session directories and aggregates parsed sessions by day and model', async () => {
    const sessionDir = join(TEST_HOME, '.codex', 'sessions', '2024', '01');
    mkdirSync(sessionDir, { recursive: true });
    jsonl(join(sessionDir, 'a.jsonl'), [
      { type: 'turn_context', timestamp: '2024-01-15T10:00:00Z', payload: { model: 'gpt-5' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 20, output_tokens: 8 } },
        },
      },
    ]);
    writeFileSync(join(sessionDir, 'ignored.txt'), 'not jsonl');

    const result = await readCodexData();

    const day = result.get('2024-01-15');
    expect(day?.inputTokens).toBe(20);
    expect(day?.outputTokens).toBe(8);
    expect(day?.byModel['gpt-5']?.inputTokens).toBe(20);
    expect(day?.byModel['gpt-5']?.outputTokens).toBe(8);
    // gpt-5: 20 * $1.25/M + 8 * $10/M = 0.000105
    expect(day?.costUSD).toBeCloseTo(0.000105);
  });

  it('deduplicates the same resolved CODEX_HOME and homedir session root', async () => {
    process.env.CODEX_HOME = join(TEST_HOME, '.codex');
    const sessionDir = join(TEST_HOME, '.codex', 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    jsonl(join(sessionDir, 'a.jsonl'), [
      { type: 'turn_context', timestamp: '2024-01-15T10:00:00Z', payload: { model: 'gpt-5' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 20, output_tokens: 8 } },
        },
      },
    ]);

    const result = await readCodexData();

    expect(result.get('2024-01-15')?.inputTokens).toBe(20);
  });
});
