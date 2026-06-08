import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${tmp}/aitrack-claude-read-test`;
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { readClaudeData } from './claude.js';

function jsonl(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
}

function assistantLine(id: string, inputTokens: number, outputTokens: number): object {
  return {
    type: 'assistant',
    timestamp: '2024-01-15T10:00:00Z',
    requestId: `req-${id}`,
    message: {
      id,
      model: 'claude',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };
}

describe('readClaudeData', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('walks configured Claude projects and merges multiple jsonl files', async () => {
    process.env.XDG_CONFIG_HOME = TEST_HOME;
    const projectDir = join(TEST_HOME, 'claude', 'projects', 'project');
    mkdirSync(projectDir, { recursive: true });
    jsonl(join(projectDir, 'a.jsonl'), [assistantLine('a', 10, 5)]);
    jsonl(join(projectDir, 'nested.jsonl'), [assistantLine('b', 20, 8)]);
    writeFileSync(join(projectDir, 'ignored.txt'), 'not jsonl');

    const result = await readClaudeData();

    expect(result.get('2024-01-15')).toMatchObject({
      inputTokens: 30,
      outputTokens: 13,
      byModel: { claude: { inputTokens: 30, outputTokens: 13 } },
    });
    expect(result.get('2024-01-15')?.costUSD).toBeCloseTo(0.000285);
    expect(result.get('2024-01-15')?.byModel.claude?.costUSD).toBeCloseTo(0.000285);
  });

  it('deduplicates messages across multiple discovered roots', async () => {
    const roots = [
      join(TEST_HOME, '.config', 'claude', 'projects', 'project'),
      join(TEST_HOME, '.claude', 'projects', 'project'),
    ];
    for (const root of roots) {
      mkdirSync(root, { recursive: true });
      jsonl(join(root, 'history.jsonl'), [assistantLine('same', 10, 5)]);
    }

    const result = await readClaudeData();

    expect(result.get('2024-01-15')?.inputTokens).toBe(10);
  });
});
