import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { localTimestamp, writeJsonl } from '../../__tests__/helpers/fixtures.js';

const TEST_HOME = vi.hoisted(() => {
  const temporary = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${temporary}/aitrack-claude-read-test`;
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { getClaudePaths, readClaudeData } from '../claude.js';

function assistantLine(id: string, inputTokens: number, outputTokens: number): object {
  return {
    type: 'assistant',
    timestamp: localTimestamp('2024-01-15'),
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
    delete process.env.AITRACK_CLAUDE_PROJECTS_DIRS;
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.AITRACK_CLAUDE_PROJECTS_DIRS;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('walks configured Claude projects and merges multiple jsonl files', async () => {
    process.env.XDG_CONFIG_HOME = TEST_HOME;
    const projectDir = join(TEST_HOME, 'claude', 'projects', 'project');
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, 'a.jsonl'), [assistantLine('a', 10, 5)]);
    writeJsonl(join(projectDir, 'nested.jsonl'), [assistantLine('b', 20, 8)]);
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

  it('drops entries whose timestamp cannot be parsed', async () => {
    process.env.XDG_CONFIG_HOME = TEST_HOME;
    const projectDir = join(TEST_HOME, 'claude', 'projects', 'project');
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, 'a.jsonl'), [
      assistantLine('good', 10, 5),
      { ...assistantLine('bad', 999, 999), timestamp: 'corrupted' },
    ]);

    const result = await readClaudeData();

    // A truthy-but-unparseable timestamp used to produce the day key
    // "NaN-NaN-NaN", which synced to git and counted toward all-time totals
    // while every year and window filter skipped it.
    expect([...result.keys()]).toEqual(['2024-01-15']);
    expect(result.get('2024-01-15')?.inputTokens).toBe(10);
  });

  it('deduplicates messages across multiple discovered roots', async () => {
    const roots = [
      join(TEST_HOME, '.config', 'claude', 'projects', 'project'),
      join(TEST_HOME, '.claude', 'projects', 'project'),
    ];
    for (const root of roots) {
      mkdirSync(root, { recursive: true });
      writeJsonl(join(root, 'history.jsonl'), [assistantLine('same', 10, 5)]);
    }

    const result = await readClaudeData();

    expect(result.get('2024-01-15')?.inputTokens).toBe(10);
  });

  it('still deduplicates across files when both are served from the parse cache', async () => {
    // The cache stores each file's contribution in isolation, so a message that
    // a resumed session copied into a second transcript looks new in both. The
    // second file has to fall back to a re-read against the running key set.
    const roots = [
      join(TEST_HOME, '.config', 'claude', 'projects', 'project'),
      join(TEST_HOME, '.claude', 'projects', 'project'),
    ];
    for (const root of roots) {
      mkdirSync(root, { recursive: true });
      writeJsonl(join(root, 'history.jsonl'), [assistantLine('same', 10, 5)]);
    }

    const cold = await readClaudeData();
    const warm = await readClaudeData();

    expect(cold.get('2024-01-15')?.inputTokens).toBe(10);
    expect(warm.get('2024-01-15')?.inputTokens).toBe(10);
  });

  it('returns the same totals from a warm cache as from a cold one', async () => {
    process.env.XDG_CONFIG_HOME = TEST_HOME;
    const projectDir = join(TEST_HOME, 'claude', 'projects', 'project');
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, 'a.jsonl'), [assistantLine('a', 10, 5)]);
    writeJsonl(join(projectDir, 'b.jsonl'), [assistantLine('b', 20, 8)]);

    const cold = await readClaudeData();
    const warm = await readClaudeData();

    expect([...warm]).toEqual([...cold]);
  });

  it('picks up an appended message once the file changes', async () => {
    process.env.XDG_CONFIG_HOME = TEST_HOME;
    const projectDir = join(TEST_HOME, 'claude', 'projects', 'project');
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, 'a.jsonl');
    writeJsonl(file, [assistantLine('a', 10, 5)]);

    await readClaudeData();
    writeJsonl(file, [assistantLine('a', 10, 5), assistantLine('b', 7, 3)]);
    const updated = await readClaudeData();

    expect(updated.get('2024-01-15')?.inputTokens).toBe(17);
  });

  it('reads custom Claude project roots from the environment', async () => {
    const customRoot = join(TEST_HOME, 'custom-claude');
    process.env.AITRACK_CLAUDE_PROJECTS_DIRS = customRoot;
    mkdirSync(customRoot, { recursive: true });
    writeJsonl(join(customRoot, 'history.jsonl'), [assistantLine('custom', 40, 10)]);

    const result = await readClaudeData();

    expect(getClaudePaths()[0]).toBe(customRoot);
    expect(result.get('2024-01-15')?.inputTokens).toBe(40);
  });
});
