import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { localTimestamp, writeJsonl } from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => {
  const temporary = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${temporary}/aitrack-codex-read-test`;
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { getCodexPaths, readCodexData } from '../codex.js';

function turn(model: string, timestamp = localTimestamp('2024-01-15')): object {
  return { type: 'turn_context', timestamp, payload: { model } };
}

function tokenCount(input_tokens: number, output_tokens: number): object {
  return {
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens, output_tokens } } },
  };
}

describe('readCodexData', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    delete process.env.CODEX_HOME;
    delete process.env.AITRACK_CODEX_SESSION_DIRS;
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
    delete process.env.AITRACK_CODEX_SESSION_DIRS;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('walks session directories and aggregates parsed sessions by day and model', async () => {
    const sessionDir = join(TEST_HOME, '.codex', 'sessions', '2024', '01');
    mkdirSync(sessionDir, { recursive: true });
    writeJsonl(join(sessionDir, 'a.jsonl'), [turn('gpt-5'), tokenCount(20, 8)]);
    writeFileSync(join(sessionDir, 'ignored.txt'), 'not jsonl');

    const result = await readCodexData();

    const day = result.get('2024-01-15');
    expect(day?.inputTokens).toBe(20);
    expect(day?.outputTokens).toBe(8);
    expect(day?.byModel['gpt-5']?.inputTokens).toBe(20);
    expect(day?.byModel['gpt-5']?.outputTokens).toBe(8);
    // gpt-5: 20 * $1.25/M + 8 * $10/M = 0.000105
    expect(day?.costUSD).toBeCloseTo(0.000105);
    expect([...(await readCodexData())]).toEqual([...result]);
  });

  it('reads custom Codex session roots from the environment', async () => {
    const customRoot = join(TEST_HOME, 'custom-codex');
    process.env.AITRACK_CODEX_SESSION_DIRS = customRoot;
    mkdirSync(customRoot, { recursive: true });
    writeJsonl(join(customRoot, 'session.jsonl'), [turn('gpt-5'), tokenCount(30, 12)]);

    const result = await readCodexData();

    expect(getCodexPaths()[0]).toBe(customRoot);
    expect(result.get('2024-01-15')?.inputTokens).toBe(30);
  });

  it('keeps the last good date when a later entry carries an unparseable timestamp', async () => {
    const sessionDir = join(TEST_HOME, '.codex', 'sessions', '2024', '01');
    mkdirSync(sessionDir, { recursive: true });
    writeJsonl(join(sessionDir, 'bad-ts.jsonl'), [
      turn('gpt-5'),
      tokenCount(10, 4),
      { type: 'turn_context', timestamp: 'not-a-real-date', payload: {} },
      tokenCount(25, 10),
    ]);

    const result = await readCodexData();

    // Neither a new day nor dropped usage: both increments land on the last parseable date.
    expect([...result.keys()]).toEqual(['2024-01-15']);
    expect(result.get('2024-01-15')?.inputTokens).toBe(25);
    expect(result.get('2024-01-15')?.outputTokens).toBe(10);
  });
});
