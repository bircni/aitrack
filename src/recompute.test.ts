import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveMachineId: vi.fn(),
  isCloned: vi.fn(),
  tryPull: vi.fn(),
  listDataFiles: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  execSync: vi.fn(),
  readLocalProviderMaps: vi.fn(),
  buildMachineData: vi.fn(),
  machineHasData: vi.fn(),
}));

vi.mock('./config.js', () => ({
  loadConfig: mocks.loadConfig,
  resolveMachineId: mocks.resolveMachineId,
}));
vi.mock('./git.js', () => ({
  LOCAL_REPO: '/repo',
  isCloned: mocks.isCloned,
  tryPull: mocks.tryPull,
  listDataFiles: mocks.listDataFiles,
}));
vi.mock('./localData.js', () => ({
  readLocalProviderMaps: mocks.readLocalProviderMaps,
  buildMachineData: mocks.buildMachineData,
  machineHasData: mocks.machineHasData,
}));
vi.mock('fs', () => ({
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
}));
vi.mock('child_process', () => ({ execSync: mocks.execSync }));

import { recomputeCostsCommand } from './recompute.js';
import type { MachineFile } from './types.js';

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

    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      '/repo/data/host.json',
      JSON.stringify(fresh, null, 2),
      'utf8',
    );
    expect(console.log).toHaveBeenCalledWith('Recomputed costs in 1 file(s).');
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
