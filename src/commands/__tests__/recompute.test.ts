import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveMachineId: vi.fn(),
  isCloned: vi.fn(),
  listDataFiles: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  execSync: vi.fn(),
  readLocalProviderMaps: vi.fn(),
  buildMachineData: vi.fn(),
  machineHasData: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  loadConfig: mocks.loadConfig,
  resolveMachineId: mocks.resolveMachineId,
}));
vi.mock('../../git.js', () => ({
  LOCAL_REPO: '/repo',
  isCloned: mocks.isCloned,
  listDataFiles: mocks.listDataFiles,
  commitDataChanges: vi.fn(() => true),
}));
vi.mock('../../data/localData.js', async () => ({
  readLocalProviderMaps: mocks.readLocalProviderMaps,
  buildMachineData: mocks.buildMachineData,
  machineHasData: mocks.machineHasData,
  // The real merge helper — this is what keeps pruned-away history in the file.
  mergePersistedDays: (
    await vi.importActual<typeof import('../../data/localData.js')>('../../data/localData.js')
  ).mergePersistedDays,
}));
vi.mock('fs', () => ({
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
}));
vi.mock('child_process', () => ({ execSync: mocks.execSync }));

import type { MachineFile } from '../../data/types.js';
import { resolveModelCost } from '../../pricing/resolve.js';
import { recomputeCostsCommand } from '../recompute.js';

const machineJson = {
  hostname: 'host',
  lastUpdated: 'old',
  days: {
    '2024-01-01': {
      claude_code: {
        byModel: { 'claude-sonnet-4-6': { inputTokens: 1_000_000, outputTokens: 100_000 } },
        totals: { inputTokens: 1_000_000, outputTokens: 100_000 },
      },
    },
  },
};

describe('recomputeCostsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCloned.mockReturnValue(true);
    mocks.loadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
    mocks.readFileSync.mockReturnValue(JSON.stringify(machineJson));
    mocks.readLocalProviderMaps.mockResolvedValue({ claude_code: new Map(), codex: new Map() });
    mocks.buildMachineData.mockReturnValue({ hostname: 'host', lastUpdated: 'now', days: {} });
    mocks.machineHasData.mockReturnValue(false);
    mocks.execSync.mockReturnValue(Buffer.from('M  data/host.json\n'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('throws when the repo has not been cloned', async () => {
    mocks.isCloned.mockReturnValue(false);
    await expect(recomputeCostsCommand()).rejects.toThrow('Repo not cloned');
  });

  it('refreshes the current machine from local JSONL when available', async () => {
    const fresh = {
      hostname: 'host',
      lastUpdated: 'now',
      days: {
        '2024-01-01': {
          claude_code: {
            byModel: {
              'claude-sonnet-4-6': {
                inputTokens: 1_000_000,
                outputTokens: 100_000,
                rawInputTokens: 100_000,
                cachedInputTokens: 900_000,
                costUSD: 4.5,
              },
            },
            totals: {
              inputTokens: 1_000_000,
              outputTokens: 100_000,
              rawInputTokens: 100_000,
              cachedInputTokens: 900_000,
              costUSD: 4.5,
            },
          },
        },
      },
    };
    mocks.buildMachineData.mockReturnValue(fresh);
    mocks.machineHasData.mockReturnValue(true);

    await recomputeCostsCommand();

    expect(mocks.writeFileSync.mock.calls[0]?.[0]).toBe('/repo/data/host.json');
    const written = mocks.writeFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as MachineFile;
    // The fresh read (with its cache breakdown) replaces the persisted day.
    expect(parsed.days['2024-01-01']?.claude_code?.totals.cachedInputTokens).toBe(900_000);
    expect(console.log).toHaveBeenCalledWith('Recomputed costs in 1 file(s).');
  });

  it('keeps current-machine days the local logs no longer cover', async () => {
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        hostname: 'host',
        lastUpdated: 'old',
        days: {
          // Older than the local logs still reach.
          '2023-06-01': {
            claude_code: {
              byModel: { 'claude-sonnet-4-6': { inputTokens: 500, outputTokens: 100 } },
              totals: { inputTokens: 500, outputTokens: 100 },
            },
          },
          '2024-01-01': machineJson.days['2024-01-01'],
        },
      }),
    );
    mocks.buildMachineData.mockReturnValue({
      hostname: 'host',
      lastUpdated: 'now',
      days: {
        // Same date as the persisted copy but with newer token counts, so the
        // file genuinely changes and gets written.
        '2024-01-01': {
          claude_code: {
            byModel: {
              'claude-sonnet-4-6': { inputTokens: 2_000_000, outputTokens: 200_000 },
            },
            totals: { inputTokens: 2_000_000, outputTokens: 200_000 },
          },
        },
      },
    });
    mocks.machineHasData.mockReturnValue(true);

    await recomputeCostsCommand();

    const written = mocks.writeFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as MachineFile;
    expect(Object.keys(parsed.days)).toEqual(['2023-06-01', '2024-01-01']);
    expect(parsed.days['2023-06-01']?.claude_code?.totals.inputTokens).toBe(500);
    expect(parsed.days['2024-01-01']?.claude_code?.totals.inputTokens).toBe(2_000_000);
  });

  it('does not rewrite or commit the current machine when nothing changed', async () => {
    // The persisted file already matches the local logs and is correctly
    // priced, so a fresh lastUpdated alone must not force a commit.
    const priced = {
      hostname: 'host',
      lastUpdated: 'old',
      days: {
        '2024-01-01': {
          claude_code: {
            byModel: {
              'claude-sonnet-4-6': {
                inputTokens: 1_000_000,
                outputTokens: 100_000,
                rawInputTokens: 100_000,
                cachedInputTokens: 900_000,
              },
            },
            totals: {
              inputTokens: 1_000_000,
              outputTokens: 100_000,
              rawInputTokens: 100_000,
              cachedInputTokens: 900_000,
            },
          },
        },
      },
    };
    mocks.readFileSync.mockReturnValue(JSON.stringify(priced));
    mocks.buildMachineData.mockReturnValue({ ...priced, lastUpdated: 'now' });
    mocks.machineHasData.mockReturnValue(true);

    // First pass writes the freshly resolved costs.
    await recomputeCostsCommand();
    const firstWrite = mocks.writeFileSync.mock.calls[0]?.[1] as string;
    expect(firstWrite).toBeDefined();

    // Second pass over that already-priced file must be a no-op.
    vi.clearAllMocks();
    mocks.isCloned.mockReturnValue(true);
    mocks.loadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
    mocks.readLocalProviderMaps.mockResolvedValue({ claude_code: new Map(), codex: new Map() });
    mocks.machineHasData.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stored = JSON.parse(firstWrite) as MachineFile;
    mocks.readFileSync.mockReturnValue(firstWrite);
    mocks.buildMachineData.mockReturnValue({ ...stored, lastUpdated: 'now' });

    await recomputeCostsCommand();

    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Nothing to recompute — costs are already current.');
  });

  it('does not rewrite the current machine over float drift in the fresh costs', async () => {
    // The readers add up a cost per JSONL entry while recompute derives one from
    // the summed tokens. The two agree mathematically but not in the last float
    // bits, and that alone must not count as a change.
    const model = 'claude-sonnet-4-6';
    const entries = 200;
    const entry = {
      inputTokens: 3_333,
      outputTokens: 777,
      rawInputTokens: 1_111,
      cachedInputTokens: 2_222,
    };
    const summed = {
      inputTokens: entry.inputTokens * entries,
      outputTokens: entry.outputTokens * entries,
      rawInputTokens: entry.rawInputTokens * entries,
      cachedInputTokens: entry.cachedInputTokens * entries,
    };
    const perEntry = resolveModelCost('claude_code', model, entry, '2024-01-01', 'recompute') ?? 0;
    let accumulated = 0;
    for (let i = 0; i < entries; i++) accumulated += perEntry;
    const derived = resolveModelCost('claude_code', model, summed, '2024-01-01', 'recompute');
    // The premise: these differ, or this test proves nothing.
    expect(accumulated).not.toBe(derived);

    const day = (costUSD: number | undefined) => ({
      '2024-01-01': {
        claude_code: {
          byModel: { [model]: { ...summed, costUSD } },
          totals: { ...summed, costUSD },
        },
      },
    });
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ hostname: 'host', lastUpdated: 'old', days: day(derived) }),
    );
    mocks.buildMachineData.mockReturnValue({
      hostname: 'host',
      lastUpdated: 'now',
      days: day(accumulated),
    });
    mocks.machineHasData.mockReturnValue(true);

    await recomputeCostsCommand();

    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Nothing to recompute — costs are already current.');
  });

  it('reprices other machines from stored cache breakdown', async () => {
    mocks.resolveMachineId.mockReturnValue('local-pc');
    mocks.listDataFiles.mockReturnValue(['/repo/data/other.json']);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        hostname: 'other',
        lastUpdated: 'old',
        days: {
          '2024-01-01': {
            claude_code: {
              byModel: {
                'claude-opus-4-7': {
                  inputTokens: 1_100_000,
                  outputTokens: 100_000,
                  rawInputTokens: 100_000,
                  cachedInputTokens: 1_000_000,
                  costUSD: 999,
                },
              },
              totals: {
                inputTokens: 1_100_000,
                outputTokens: 100_000,
                rawInputTokens: 100_000,
                cachedInputTokens: 1_000_000,
                costUSD: 999,
              },
            },
          },
        },
      }),
    );

    await recomputeCostsCommand();

    const written = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1])) as MachineFile;
    expect(
      written.days['2024-01-01']?.claude_code?.byModel['claude-opus-4-7']?.costUSD,
    ).toBeCloseTo(3.5, 5);
  });

  it('repairs a stale day total when model costs are already current', async () => {
    mocks.resolveMachineId.mockReturnValue('local-pc');
    mocks.listDataFiles.mockReturnValue(['/repo/data/other.json']);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        hostname: 'other',
        lastUpdated: 'old',
        days: {
          '2024-01-01': {
            claude_code: {
              byModel: {
                'claude-opus-4-7': {
                  inputTokens: 1_100_000,
                  outputTokens: 100_000,
                  rawInputTokens: 100_000,
                  cachedInputTokens: 1_000_000,
                  costUSD: 3.5,
                },
              },
              totals: {
                inputTokens: 1_100_000,
                outputTokens: 100_000,
                rawInputTokens: 100_000,
                cachedInputTokens: 1_000_000,
                costUSD: 999,
              },
            },
          },
        },
      }),
    );

    await recomputeCostsCommand();

    const written = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1])) as MachineFile;
    expect(written.days['2024-01-01']?.claude_code?.totals.costUSD).toBeCloseTo(3.5, 5);
    expect(
      written.days['2024-01-01']?.claude_code?.byModel['claude-opus-4-7']?.costUSD,
    ).toBeCloseTo(3.5, 5);
  });

  it('preserves an aggregate cost when an unknown model has no stored cost', async () => {
    mocks.resolveMachineId.mockReturnValue('local-pc');
    mocks.listDataFiles.mockReturnValue(['/repo/data/other.json']);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        hostname: 'other',
        lastUpdated: 'old',
        days: {
          '2024-01-01': {
            codex: {
              byModel: { unknown: { inputTokens: 100, outputTokens: 10 } },
              totals: { inputTokens: 100, outputTokens: 10, costUSD: 999 },
            },
          },
        },
      }),
    );

    await recomputeCostsCommand();

    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Nothing to recompute — costs are already current.');
  });

  it('leaves legacy rows without cache breakdown unchanged', async () => {
    mocks.resolveMachineId.mockReturnValue('local-pc');
    mocks.listDataFiles.mockReturnValue(['/repo/data/other.json']);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        hostname: 'other',
        lastUpdated: 'old',
        days: {
          '2024-01-01': {
            claude_code: {
              byModel: {
                'claude-sonnet-4-6': {
                  inputTokens: 1_000_000,
                  outputTokens: 100_000,
                  costUSD: 4.5,
                },
              },
              totals: { inputTokens: 1_000_000, outputTokens: 100_000, costUSD: 4.5 },
            },
          },
        },
      }),
    );

    await recomputeCostsCommand();

    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Nothing to recompute — costs are already current.');
  });
});
