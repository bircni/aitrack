import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localTimestamp, writeJsonl } from '../../__tests__/helpers/fixtures.js';
import { parseSessionFile } from '../codex.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codex-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseSessionFile', () => {
  it('parses a session with cumulative total_token_usage', async () => {
    const file = join(tmpDir, 's.jsonl');
    writeJsonl(file, [
      {
        type: 'turn_context',
        timestamp: localTimestamp('2024-01-15'),
        payload: { model: 'gpt-4o' },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 200, output_tokens: 100 } },
        },
      },
    ]);

    const result = await parseSessionFile(file);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      dateStr: '2024-01-15',
      model: 'gpt-4o',
      inputTokens: 200,
      outputTokens: 100,
    });
  });

  it('tracks deltas across multiple token_count events', async () => {
    const file = join(tmpDir, 's.jsonl');
    writeJsonl(file, [
      {
        type: 'turn_context',
        timestamp: localTimestamp('2024-01-15'),
        payload: { model: 'gpt-4o' },
      },
      // cumulative after turn 1
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
        },
      },
      // cumulative after turn 2 (delta: +200 in, +100 out)
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 300, output_tokens: 150 } },
        },
      },
    ]);

    const result = await parseSessionFile(file);
    expect(result[0]).toMatchObject({ inputTokens: 300, outputTokens: 150 });
  });

  it('detects context window rollback and adds last_token_usage', async () => {
    // When total drops (new context window), the code uses last_token_usage for that turn
    const file = join(tmpDir, 's.jsonl');
    writeJsonl(file, [
      {
        type: 'turn_context',
        timestamp: localTimestamp('2024-01-15'),
        payload: { model: 'gpt-4o' },
      },
      // turn 1 — accumulated: 100 in, 50 out
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
        },
      },
      // turn 2 — total drops (rollback), last = 80 in, 40 out → accumulated: 180 in, 90 out
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 80, output_tokens: 40 },
            last_token_usage: { input_tokens: 80, output_tokens: 40 },
          },
        },
      },
    ]);

    const result = await parseSessionFile(file);
    expect(result[0]).toMatchObject({ inputTokens: 180, outputTokens: 90 });
  });

  it('falls back to last_token_usage when no total is present', async () => {
    const file = join(tmpDir, 's.jsonl');
    writeJsonl(file, [
      {
        type: 'turn_context',
        timestamp: localTimestamp('2024-01-15'),
        payload: { model: 'gpt-4o' },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 50, output_tokens: 25 } },
        },
      },
    ]);

    const result = await parseSessionFile(file);
    expect(result[0]).toMatchObject({ inputTokens: 50, outputTokens: 25 });
  });

  it('returns null for a session with no token events', async () => {
    const file = join(tmpDir, 's.jsonl');
    writeJsonl(file, [
      {
        type: 'turn_context',
        timestamp: localTimestamp('2024-01-15'),
        payload: { model: 'gpt-4o' },
      },
      { type: 'user_message', content: 'hello' },
    ]);

    expect(await parseSessionFile(file)).toEqual([]);
  });

  it('returns null for an empty file', async () => {
    const file = join(tmpDir, 'empty.jsonl');
    writeFileSync(file, '');
    expect(await parseSessionFile(file)).toEqual([]);
  });

  it('uses the timestamp of the first entry as the session date', async () => {
    const file = join(tmpDir, 's.jsonl');
    const firstDate = localTimestamp('2024-06-01');
    const expected = '2024-06-01';

    writeJsonl(file, [
      { type: 'turn_context', timestamp: firstDate, payload: { model: 'gpt-4o' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } },
        },
      },
    ]);

    const result = await parseSessionFile(file);
    expect(result[0]).toMatchObject({ dateStr: expected });
  });

  it('splits cumulative usage by the active model and local day', async () => {
    const file = join(tmpDir, 's.jsonl');
    writeJsonl(file, [
      {
        type: 'turn_context',
        timestamp: localTimestamp('2024-01-15', 10),
        payload: { model: 'gpt-5.1-codex' },
      },
      {
        type: 'event_msg',
        timestamp: localTimestamp('2024-01-15', 10),
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
        },
      },
      {
        type: 'turn_context',
        timestamp: localTimestamp('2024-01-16', 10),
        payload: { model: 'gpt-5.4' },
      },
      {
        type: 'event_msg',
        timestamp: localTimestamp('2024-01-16', 10),
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 250, output_tokens: 25 } },
        },
      },
    ]);

    expect(await parseSessionFile(file)).toEqual([
      {
        dateStr: '2024-01-15',
        model: 'gpt-5.1-codex',
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 0,
      },
      {
        dateStr: '2024-01-16',
        model: 'gpt-5.4',
        inputTokens: 150,
        outputTokens: 15,
        cachedInputTokens: 0,
      },
    ]);
  });
});
