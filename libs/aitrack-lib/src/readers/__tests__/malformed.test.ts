import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { localTimestamp } from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => {
  const temporary = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${temporary}/aitrack-malformed-log-test`;
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { buildMachineData } from '../../data/localData.js';
import type { DayMap } from '../../data/types.js';
import { checkMachineFile } from '../../data/validate.js';
import { readClaudeData } from '../claude.js';
import { readCodexData } from '../codex.js';
import { aggregateCursorCsvToDayMap } from '../cursor/csv.js';

const DAY = '2024-01-15';
const TIME = localTimestamp(DAY);
/** As raw JSON, because `1e999` has no JSON.stringify form. */
const BAD_TOKENS = ['"oops"', '1e999', '-5', '0.1', '1152921504606846976', '{}', 'true'];
const BAD_MODELS = ['"toString"', '"constructor"', '"__proto__"', '"hasOwnProperty"', '7', '{}'];

function writeLog(root: string, lines: string[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'log.jsonl'), `${lines.join('\n')}\n`);
}

function claudeLine(
  id: string,
  input = '10',
  { model = '"claude-sonnet-4-6"', time = `"${TIME}"` } = {},
) {
  return `{"type":"assistant","timestamp":${time},"requestId":"r${id}","message":{"id":"${id}","model":${model},"usage":{"input_tokens":${input},"output_tokens":1}}}`;
}

function codexLine(usage: string): string {
  return `{"type":"event_msg","timestamp":"${TIME}","payload":{"type":"token_count","info":{${usage}}}}`;
}

function turnLine(model = '"gpt-5"'): string {
  return `{"type":"turn_context","timestamp":"${TIME}","payload":{"model":${model}}}`;
}

function readClaude(lines: string[]): Promise<DayMap> {
  writeLog(join(TEST_HOME, '.claude', 'projects', 'p'), lines);
  return readClaudeData();
}

function readCodex(lines: string[]): Promise<DayMap> {
  writeLog(join(TEST_HOME, '.codex', 'sessions'), lines);
  return readCodexData();
}

/** What the sync does with a read: a machine file its own validator has to accept. */
function expectValidMachineFile(days: DayMap): void {
  const file = buildMachineData('host', { provider: days });
  const { machine, diagnostics } = checkMachineFile(JSON.parse(JSON.stringify(file)), 'host.json');
  expect(diagnostics).toEqual([]);
  expect(machine).not.toBeNull();
  const day = days.get(DAY);
  const sum = Object.values(day?.byModel ?? {}).reduce((total, row) => total + row.inputTokens, 0);
  expect(sum).toBe(day?.inputTokens);
}

describe('malformed provider log values', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    process.env.AITRACK_NO_CACHE = '1';
  });

  afterEach(() => {
    delete process.env.AITRACK_NO_CACHE;
    rmSync(TEST_HOME, { recursive: true, force: true });
    delete (Object.prototype as Record<string, unknown>).inputTokens;
    delete (Object.prototype as Record<string, unknown>).outputTokens;
  });

  it.each(BAD_TOKENS)('Claude drops a record with %s tokens and keeps the rest', async (bad) => {
    const days = await readClaude([claudeLine('a'), claudeLine('b', bad), claudeLine('c')]);
    expectValidMachineFile(days);
    expect(days.get(DAY)?.inputTokens).toBe(20);
  });

  it('Claude drops a record with a malformed cache write bucket', async () => {
    const line = `{"type":"assistant","timestamp":"${TIME}","message":{"id":"x","usage":{"input_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":"oops"}}}}`;
    const days = await readClaude([claudeLine('a'), line]);
    expectValidMachineFile(days);
    expect(days.get(DAY)?.inputTokens).toBe(10);
  });

  it.each(BAD_MODELS)('Claude counts a record with model %s as unknown', async (model) => {
    const days = await readClaude([claudeLine('a', '10', { model })]);
    expectValidMachineFile(days);
    expect(Object.keys(days.get(DAY)?.byModel ?? {})).toEqual(['unknown']);
    expect(({} as Record<string, unknown>).inputTokens).toBeUndefined();
  });

  it.each(['12345', '{}', '"not a date"', '"+275760-01-01T00:00:00Z"', '"0001-06-15T12:00:00Z"'])(
    'Claude drops a record with timestamp %s',
    async (time) => {
      const days = await readClaude([claudeLine('a'), claudeLine('b', '10', { time })]);
      expectValidMachineFile(days);
      expect([...days.keys()]).toEqual([DAY]);
      expect(days.get(DAY)?.inputTokens).toBe(10);
    },
  );

  it('Claude ignores a cwd that is not a usable path', async () => {
    const days = await readClaude([
      `{"type":"user","cwd":"__proto__"}`,
      claudeLine('a'),
      `{"type":"user","cwd":5}`,
      claudeLine('b'),
    ]);
    expectValidMachineFile(days);
    expect(days.get(DAY)?.byCwd).toBeUndefined();
    expect(({} as Record<string, unknown>).inputTokens).toBeUndefined();
  });

  it.each(BAD_TOKENS)('Codex skips a cumulative total of %s until a good one', async (bad) => {
    const days = await readCodex([
      turnLine(),
      codexLine('"total_token_usage":{"input_tokens":100,"output_tokens":10}'),
      codexLine(`"total_token_usage":{"input_tokens":${bad},"output_tokens":20}`),
      codexLine('"total_token_usage":{"input_tokens":150,"output_tokens":30}'),
    ]);
    expectValidMachineFile(days);
    expect(days.get(DAY)).toMatchObject({ inputTokens: 150, outputTokens: 30 });
  });

  it.each(BAD_TOKENS)('Codex drops a last-usage record of %s', async (bad) => {
    const days = await readCodex([
      turnLine(),
      codexLine('"last_token_usage":{"input_tokens":100,"output_tokens":10}'),
      codexLine(`"last_token_usage":{"input_tokens":5,"cached_input_tokens":${bad}}`),
    ]);
    expectValidMachineFile(days);
    expect(days.get(DAY)).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });

  it.each(BAD_MODELS)('Codex keeps the previous model over %s', async (model) => {
    const days = await readCodex([
      turnLine(),
      turnLine(model),
      codexLine('"last_token_usage":{"input_tokens":100,"output_tokens":10}'),
    ]);
    expectValidMachineFile(days);
    expect(Object.keys(days.get(DAY)?.byModel ?? {})).toEqual(['gpt-5']);
  });

  it('Codex ignores a timestamp, cwd or remote of the wrong type', async () => {
    const days = await readCodex([
      `{"type":"session_meta","timestamp":12345,"payload":{"cwd":5,"git":{"repository_url":7}}}`,
      `{"type":"session_meta","timestamp":"${TIME}","payload":{"cwd":"__proto__"}}`,
      turnLine(),
      codexLine('"last_token_usage":{"input_tokens":100,"output_tokens":10}'),
    ]);
    expectValidMachineFile(days);
    expect(days.get(DAY)?.byCwd).toBeUndefined();
    expect(days.get(DAY)?.inputTokens).toBe(100);
  });

  it('Cursor files a row under a safe model and drops an implausible count', () => {
    const days = aggregateCursorCsvToDayMap(
      [
        'Date,Model,Input (w/o Cache Write),Output Tokens',
        `${DAY},toString,10,1`,
        `${DAY},__proto__,10,1`,
        `${DAY},gpt-5,1e30,1`,
      ].join('\n'),
    );
    expectValidMachineFile(days);
    expect(days.get(DAY)?.byModel).toMatchObject({ unknown: { inputTokens: 20 } });
    expect(days.get(DAY)?.byModel['gpt-5']).toMatchObject({ inputTokens: 0, outputTokens: 1 });
  });
});
