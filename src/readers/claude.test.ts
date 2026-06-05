import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  estimateClaudeCostFromStoredCounts,
  estimateClaudeCostUSD,
  parseJsonlFile,
} from './claude.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'claude-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function jsonl(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
}

describe('parseJsonlFile', () => {
  it('parses a basic assistant message', async () => {
    const file = join(tmpDir, 'a.jsonl');
    jsonl(file, [
      {
        type: 'assistant',
        timestamp: '2024-01-15T10:00:00Z',
        requestId: 'r1',
        message: {
          id: 'msg1',
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]);

    const result = await parseJsonlFile(file, new Set());
    expect(result.size).toBe(1);
    const day = result.get('2024-01-15');
    expect(day?.inputTokens).toBe(100);
    expect(day?.outputTokens).toBe(50);
    expect(day?.costUSD).toBeCloseTo(0.001_05);
    expect(day?.byModel['claude-3-5-sonnet-20241022']).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(day?.byModel['claude-3-5-sonnet-20241022']?.costUSD).toBeCloseTo(0.001_05);
  });

  it('strips -latest suffix from model names', async () => {
    const file = join(tmpDir, 'a.jsonl');
    jsonl(file, [
      {
        type: 'assistant',
        timestamp: '2024-01-15T10:00:00Z',
        requestId: 'r1',
        message: {
          id: 'msg1',
          model: 'claude-3-5-sonnet-latest',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);

    const result = await parseJsonlFile(file, new Set());
    expect(result.get('2024-01-15')?.byModel).toHaveProperty('claude-3-5-sonnet');
    expect(result.get('2024-01-15')?.byModel).not.toHaveProperty('claude-3-5-sonnet-latest');
  });

  it('deduplicates by message+request ID across calls', async () => {
    const file = join(tmpDir, 'a.jsonl');
    jsonl(file, [
      {
        type: 'assistant',
        timestamp: '2024-01-15T10:00:00Z',
        requestId: 'r1',
        message: { id: 'msg1', model: 'claude', usage: { input_tokens: 100, output_tokens: 50 } },
      },
      // same msg1:r1 key — should be skipped
      {
        type: 'assistant',
        timestamp: '2024-01-15T11:00:00Z',
        requestId: 'r1',
        message: { id: 'msg1', model: 'claude', usage: { input_tokens: 100, output_tokens: 50 } },
      },
    ]);

    const result = await parseJsonlFile(file, new Set());
    expect(result.get('2024-01-15')?.inputTokens).toBe(100); // not 200
  });

  it('adds cache tokens to their respective counters', async () => {
    const file = join(tmpDir, 'a.jsonl');
    jsonl(file, [
      {
        type: 'assistant',
        timestamp: '2024-01-15T10:00:00Z',
        requestId: 'r1',
        message: {
          id: 'msg1',
          model: 'claude',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 50,
            output_tokens: 25,
            cache_creation_input_tokens: 10,
          },
        },
      },
    ]);

    const result = await parseJsonlFile(file, new Set());
    const day = result.get('2024-01-15');
    expect(day?.inputTokens).toBe(160); // 100 + 50 cache_read + 10 cache_creation
    expect(day?.outputTokens).toBe(25);
    expect(day?.rawInputTokens).toBe(100);
    expect(day?.cachedInputTokens).toBe(50);
    expect(day?.cacheCreationInputTokens).toBe(10);
    expect(day?.costUSD).toBeCloseTo(0.000_727_5);
  });

  it('estimates Claude API-equivalent costs by exact model id', () => {
    // Opus 4.5+ all at $5/$25 (not the old $15/$75)
    expect(
      estimateClaudeCostUSD('claude-opus-4-7', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(30);
    expect(
      estimateClaudeCostUSD('claude-opus-4-6', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(30);
    // Opus 4.1 still on the old pricing
    expect(
      estimateClaudeCostUSD('claude-opus-4-1', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(90);
    expect(
      estimateClaudeCostUSD('claude-sonnet-4-6', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(18);
    // Date-suffixed Haiku 4.5 should match the dateless entry
    expect(
      estimateClaudeCostUSD('claude-haiku-4-5-20251001', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(6);
    expect(
      estimateClaudeCostUSD('claude-haiku-3-5', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(4.8);
  });

  it('uses cache-specific pricing and defaults unknown Claude models to Sonnet', () => {
    expect(
      estimateClaudeCostUSD('unknown', {
        input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(22.05);
  });

  it('reprices from stored cache breakdown without inflating cache reads', () => {
    const cost = estimateClaudeCostFromStoredCounts('claude-opus-4-7', {
      inputTokens: 1_100_000,
      outputTokens: 100_000,
      rawInputTokens: 100_000,
      cachedInputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
    });
    // 100k*$5/M + 1M*$0.5/M + 100k*$25/M = 0.5 + 0.5 + 2.5 = 3.5
    expect(cost).toBeCloseTo(3.5, 5);
    expect(
      estimateClaudeCostFromStoredCounts('claude-opus-4-7', {
        inputTokens: 1_100_000,
        outputTokens: 100_000,
      }),
    ).toBeUndefined();
  });

  it('skips non-assistant entries', async () => {
    const file = join(tmpDir, 'a.jsonl');
    jsonl(file, [
      { type: 'user', timestamp: '2024-01-15T10:00:00Z' },
      { type: 'summary', timestamp: '2024-01-15T10:00:00Z' },
    ]);

    const result = await parseJsonlFile(file, new Set());
    expect(result.size).toBe(0);
  });

  it('skips assistant entries with zero output tokens', async () => {
    const file = join(tmpDir, 'a.jsonl');
    jsonl(file, [
      {
        type: 'assistant',
        timestamp: '2024-01-15T10:00:00Z',
        requestId: 'r1',
        message: { id: 'msg1', model: 'claude', usage: { input_tokens: 100, output_tokens: 0 } },
      },
    ]);

    const result = await parseJsonlFile(file, new Set());
    expect(result.size).toBe(0);
  });

  it('accumulates multiple messages across different days', async () => {
    const file = join(tmpDir, 'a.jsonl');
    jsonl(file, [
      {
        type: 'assistant',
        timestamp: '2024-01-15T10:00:00Z',
        requestId: 'r1',
        message: { id: 'msg1', model: 'claude', usage: { input_tokens: 100, output_tokens: 50 } },
      },
      {
        type: 'assistant',
        timestamp: '2024-01-16T10:00:00Z',
        requestId: 'r2',
        message: { id: 'msg2', model: 'claude', usage: { input_tokens: 200, output_tokens: 100 } },
      },
    ]);

    const result = await parseJsonlFile(file, new Set());
    expect(result.size).toBe(2);
    expect(result.get('2024-01-15')?.inputTokens).toBe(100);
    expect(result.get('2024-01-16')?.inputTokens).toBe(200);
  });
});
