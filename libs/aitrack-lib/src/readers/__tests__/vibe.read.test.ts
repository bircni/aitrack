import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { providerFixture, useTimeZone } from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => {
  const temporary = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${temporary}/aitrack-vibe-read-test`;
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { readVibeData } from '../vibe.js';

useTimeZone('UTC');

const VIBE_HOME = join(TEST_HOME, '.vibe');

function writeVibeConfig(activeModel: string): void {
  writeFileSync(
    join(VIBE_HOME, 'config.toml'),
    `active_model = "${activeModel}"\n\n[[models]]\nprovider = "mistral"\nname = "mistral-large-4"\nalias = "mistral-large-4-0-3"\n`,
  );
}

describe('readVibeData', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(VIBE_HOME, { recursive: true });
    process.env.VIBE_HOME = VIBE_HOME;
    process.env.AITRACK_VIBE_SESSION_DIRS = providerFixture('vibe-sessions');
    process.env.AITRACK_NO_CACHE = '1';
  });

  afterEach(() => {
    delete process.env.VIBE_HOME;
    delete process.env.AITRACK_VIBE_SESSION_DIRS;
    delete process.env.AITRACK_NO_CACHE;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('reads legacy and unified sessions, pricing cache hits at 10% of input', async () => {
    writeVibeConfig('mistral-large-4-0-3');

    const days = await readVibeData();

    // Legacy: the config snapshot's alias, since its API name `mistral-vibe-cli-latest` has no rate.
    const legacy = days.get('2025-03-10')?.byModel['mistral-medium-3.5'];
    expect(legacy).toMatchObject({
      inputTokens: 120_000,
      outputTokens: 2000,
      cachedInputTokens: 100_000,
    });
    expect(legacy?.costUSD).toBeCloseTo((20_000 * 1.5 + 100_000 * 0.15 + 2000 * 7.5) / 1e6, 10);
    const unified = days.get('2025-03-11')?.byModel;
    // Unpinned: config.toml's default, by its priced API name.
    expect(unified?.['mistral-large-4']).toMatchObject({ inputTokens: 50_000, outputTokens: 1000 });
    expect(unified?.['mistral-large-4']?.costUSD).toBeCloseTo(
      (10_000 * 1.36 + 40_000 * 0.136 + 1000 * 4.18) / 1e6,
      10,
    );
    // Pinned per session, and not in the rate table.
    expect(unified?.['devstral-2512']).toMatchObject({
      inputTokens: 3000,
      hasUnpricedTokens: true,
    });
  });

  it('keeps the model first recorded for an unpinned session after the default changes', async () => {
    writeVibeConfig('mistral-large-4-0-3');
    await readVibeData();

    writeVibeConfig('mistral-medium-3.5');
    const days = await readVibeData();

    expect(Object.keys(days.get('2025-03-11')?.byModel ?? {}).toSorted()).toEqual([
      'devstral-2512',
      'mistral-large-4',
    ]);
    const ledger: unknown = JSON.parse(
      readFileSync(join(TEST_HOME, '.config', 'aitrack', 'vibe-models.json'), 'utf8'),
    );
    expect(ledger).toEqual({
      'bbbb2222-0000-0000-0000-000000000000': {
        alias: 'mistral-large-4-0-3',
        name: 'mistral-large-4',
      },
    });
  });

  it('follows session_logging in config.toml and prices an API name by family', async () => {
    delete process.env.AITRACK_VIBE_SESSION_DIRS;
    writeFileSync(
      join(VIBE_HOME, 'config.toml'),
      '[session_logging]\nsave_dir = "~/chats"\nsession_prefix = "chat"\n',
    );
    mkdirSync(join(TEST_HOME, 'chats', 'chat_1'), { recursive: true });
    writeFileSync(
      join(TEST_HOME, 'chats', 'chat_1', 'meta.json'),
      JSON.stringify({
        end_time: '2025-03-10T12:00:00Z',
        config: {
          active_model: 'compact',
          models: { compact: { name: 'mistral-small-latest' } },
        },
        stats: { session_prompt_tokens: 1_000_000, session_completion_tokens: 0 },
      }),
    );

    const days = await readVibeData();

    expect(days.get('2025-03-10')?.byModel['mistral-small']?.costUSD).toBeCloseTo(0.15, 10);
  });

  it('skips sessions that are mid-write, malformed or empty', async () => {
    const root = join(TEST_HOME, 'sessions');
    const unified = join(root, 'unified');
    mkdirSync(join(root, 'session_empty'), { recursive: true });
    mkdirSync(join(root, 'session_partial'), { recursive: true });
    mkdirSync(join(unified, 'bad-generation'), { recursive: true });
    mkdirSync(join(unified, 'no-runtime', 'generations', '1'), { recursive: true });
    writeFileSync(join(root, 'session_empty', 'meta.json'), '{"end_time": "2025-03-10T12:00:00Z"}');
    writeFileSync(join(root, 'session_partial', 'meta.json'), '{"stats": ');
    writeFileSync(join(unified, 'bad-generation', 'CURRENT'), '{"generation": "../x"}');
    writeFileSync(join(unified, 'no-runtime', 'CURRENT'), '{"generation": "1"}');
    writeFileSync(
      join(unified, 'no-runtime', 'generations', '1', 'projection-state.json'),
      '{"snapshot": {"session": {"updatedAt": 1741694400000, "tokenUsage": {"inputTokens": 7}}}}',
    );
    process.env.AITRACK_VIBE_SESSION_DIRS = `${root},${root},${join(TEST_HOME, 'missing')}`;

    const days = await readVibeData();

    // No config.toml either: Vibe's built-in default model.
    expect([...days.keys()]).toEqual(['2025-03-11']);
    expect(days.get('2025-03-11')?.byModel['mistral-medium-3.5']?.inputTokens).toBe(7);
  });
});
