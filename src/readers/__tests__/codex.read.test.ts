import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

function jsonl(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
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

  it('keeps model and day transitions separate within one session', async () => {
    const sessionDir = join(TEST_HOME, '.codex', 'sessions', '2024', '01');
    mkdirSync(sessionDir, { recursive: true });
    jsonl(join(sessionDir, 'a.jsonl'), [
      {
        type: 'turn_context',
        timestamp: new Date(2024, 0, 15, 10).toISOString(),
        payload: { model: 'gpt-5.1-codex' },
      },
      {
        type: 'event_msg',
        timestamp: new Date(2024, 0, 15, 10, 1).toISOString(),
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
        },
      },
      {
        type: 'turn_context',
        timestamp: new Date(2024, 0, 16, 10).toISOString(),
        payload: { model: 'gpt-5.4' },
      },
      {
        type: 'event_msg',
        timestamp: new Date(2024, 0, 16, 10, 1).toISOString(),
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 250, output_tokens: 25 } },
        },
      },
    ]);

    const result = await readCodexData();

    expect(result.get('2024-01-15')?.byModel['gpt-5.1-codex']).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(result.get('2024-01-16')?.byModel['gpt-5.4']).toMatchObject({
      inputTokens: 150,
      outputTokens: 15,
    });
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

  it('reads custom Codex session roots from the environment', async () => {
    const customRoot = join(TEST_HOME, 'custom-codex');
    process.env.AITRACK_CODEX_SESSION_DIRS = customRoot;
    mkdirSync(customRoot, { recursive: true });
    jsonl(join(customRoot, 'session.jsonl'), [
      { type: 'turn_context', timestamp: '2024-01-15T10:00:00Z', payload: { model: 'gpt-5' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 30, output_tokens: 12 } },
        },
      },
    ]);

    const result = await readCodexData();

    expect(getCodexPaths()[0]).toBe(customRoot);
    expect(result.get('2024-01-15')?.inputTokens).toBe(30);
  });
});
