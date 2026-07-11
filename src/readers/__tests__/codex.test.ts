import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSessionFile } from '../codex.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codex-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function jsonl(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
}

describe('parseSessionFile', () => {
  it('parses a session with cumulative total_token_usage', async () => {
    const file = join(tmpDir, 's.jsonl');
    jsonl(file, [
      { type: 'turn_context', timestamp: '2024-01-15T10:00:00Z', payload: { model: 'gpt-4o' } },
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
    jsonl(file, [
      { type: 'turn_context', timestamp: '2024-01-15T10:00:00Z', payload: { model: 'gpt-4o' } },
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
    jsonl(file, [
      { type: 'turn_context', timestamp: '2024-01-15T10:00:00Z', payload: { model: 'gpt-4o' } },
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
    jsonl(file, [
      { type: 'turn_context', timestamp: '2024-01-15T10:00:00Z', payload: { model: 'gpt-4o' } },
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
    jsonl(file, [
      { type: 'turn_context', timestamp: '2024-01-15T10:00:00Z', payload: { model: 'gpt-4o' } },
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
    // Use noon UTC so local-date conversion is unambiguous in any timezone (UTC-12 to UTC+14)
    const firstDate = new Date('2024-06-01T12:00:00Z');
    const y = firstDate.getFullYear();
    const m = String(firstDate.getMonth() + 1).padStart(2, '0');
    const d = String(firstDate.getDate()).padStart(2, '0');
    const expected = `${y}-${m}-${d}`;

    jsonl(file, [
      { type: 'turn_context', timestamp: firstDate.toISOString(), payload: { model: 'gpt-4o' } },
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
    const firstDay = new Date(2024, 0, 15, 10, 0, 0);
    const secondDay = new Date(2024, 0, 16, 10, 0, 0);
    jsonl(file, [
      {
        type: 'turn_context',
        timestamp: firstDay.toISOString(),
        payload: { model: 'gpt-5.1-codex' },
      },
      {
        type: 'event_msg',
        timestamp: new Date(2024, 0, 15, 10, 1, 0).toISOString(),
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
        },
      },
      {
        type: 'turn_context',
        timestamp: secondDay.toISOString(),
        payload: { model: 'gpt-5.4' },
      },
      {
        type: 'event_msg',
        timestamp: new Date(2024, 0, 16, 10, 1, 0).toISOString(),
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
