import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryLoadConfig: vi.fn(),
  resolveMachineId: vi.fn(),
  isCloned: vi.fn(),
  listDataFiles: vi.fn(),
  readDataFile: vi.fn(),
  writePendingMachineFile: vi.fn(),
  buildLocalMachineFile: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  tryLoadConfig: mocks.tryLoadConfig,
  resolveMachineId: mocks.resolveMachineId,
}));
vi.mock('../../git.js', () => ({
  isCloned: mocks.isCloned,
  listDataFiles: mocks.listDataFiles,
  readDataFile: mocks.readDataFile,
  writePendingMachineFile: mocks.writePendingMachineFile,
}));
vi.mock('../localData.js', () => ({
  buildLocalMachineFile: mocks.buildLocalMachineFile,
  machineHasData: (machine: { days: Record<string, unknown> }) =>
    Object.keys(machine.days).length > 0,
}));

import type { DayEntry, MachineFile, ProviderDay } from '../types.js';
import { loadMergedProviderData, mergeProviderDay } from '../usageData.js';

function emptyDay(): DayEntry {
  return { inputTokens: 0, outputTokens: 0, byModel: {} };
}

function emptyLocalMachine(host = 'host'): MachineFile {
  return { hostname: host, lastUpdated: 'now', days: {} };
}

describe('mergeProviderDay', () => {
  it('prefers totals.costUSD over summing per-model costs', () => {
    const rec = emptyDay();
    const pData: ProviderDay = {
      byModel: {
        m1: { inputTokens: 10, outputTokens: 5, costUSD: 0.5 },
        m2: { inputTokens: 20, outputTokens: 7, costUSD: 1 },
      },
      totals: { inputTokens: 30, outputTokens: 12, costUSD: 1.7 },
    };
    mergeProviderDay(rec, 'claude_code', pData);
    expect(rec.costUSD).toBe(1.7);
  });

  it('falls back to summed model costs when totals.costUSD is missing', () => {
    const rec = emptyDay();
    const pData: ProviderDay = {
      byModel: {
        'claude-sonnet-4-6': { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      },
      totals: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    };
    mergeProviderDay(rec, 'claude_code', pData);
    expect(rec.costUSD).toBe(18);
  });

  it('uses stored Claude cache breakdown when backfilling a missing day cost', () => {
    const rec = emptyDay();
    const pData: ProviderDay = {
      byModel: {
        'claude-opus-4-7': {
          inputTokens: 1_100_000,
          outputTokens: 100_000,
          rawInputTokens: 100_000,
          cachedInputTokens: 1_000_000,
          cacheCreationInputTokens: 0,
        },
      },
      totals: {
        inputTokens: 1_100_000,
        outputTokens: 100_000,
        rawInputTokens: 100_000,
        cachedInputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
      },
    };

    mergeProviderDay(rec, 'claude_code', pData, '2026-01-01');

    expect(rec.costUSD).toBeCloseTo(3.5, 5);
    expect(rec.byModel['claude-opus-4-7']?.costUSD).toBeCloseTo(3.5, 5);
  });

  it('leaves costUSD undefined for non-claude providers when costs are missing', () => {
    const rec = emptyDay();
    const pData: ProviderDay = {
      byModel: { gpt: { inputTokens: 100, outputTokens: 50 } },
      totals: { inputTokens: 100, outputTokens: 50 },
    };
    mergeProviderDay(rec, 'codex', pData);
    expect(rec.costUSD).toBeUndefined();
  });

  it('accumulates token counts across repeated calls', () => {
    const rec = emptyDay();
    const pData: ProviderDay = {
      byModel: { m: { inputTokens: 10, outputTokens: 5 } },
      totals: { inputTokens: 10, outputTokens: 5 },
    };
    mergeProviderDay(rec, 'codex', pData);
    mergeProviderDay(rec, 'codex', pData);
    expect(rec.inputTokens).toBe(20);
    expect(rec.byModel.m?.outputTokens).toBe(10);
  });
});

describe('loadMergedProviderData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);
    mocks.buildLocalMachineFile.mockResolvedValue(emptyLocalMachine());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('renders local-only when config is missing', async () => {
    mocks.buildLocalMachineFile.mockResolvedValue({
      hostname: 'host',
      lastUpdated: 'now',
      days: {
        '2024-01-01': {
          claude_code: {
            byModel: { claude: { inputTokens: 10, outputTokens: 5 } },
            totals: { inputTokens: 10, outputTokens: 5 },
          },
        },
      },
    });

    const loaded = await loadMergedProviderData({
      providers: ['claude_code', 'codex'],
      stagePending: true,
    });

    expect(console.warn).not.toHaveBeenCalled();
    expect(mocks.writePendingMachineFile).toHaveBeenCalled();
    expect(loaded?.providerData.claude_code?.get('2024-01-01')?.inputTokens).toBe(10);
    expect(loaded?.machineData).toEqual([]);
    expect(loaded?.warnedNotConfigured).toBe(true);
  });

  it('does not stage pending data by default', async () => {
    mocks.buildLocalMachineFile.mockResolvedValue(emptyLocalMachine());

    await loadMergedProviderData({ providers: ['claude_code'] });

    expect(mocks.writePendingMachineFile).not.toHaveBeenCalled();
  });

  it('merges git data from other machines and overlays fresh local read', async () => {
    mocks.tryLoadConfig.mockReturnValue({
      repoUrl: 'git@example.com:me/data.git',
      machineId: 'host',
    });
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.isCloned.mockReturnValue(true);
    mocks.listDataFiles.mockReturnValue(['/repo/data/other.json', '/repo/data/host.json']);
    mocks.readDataFile.mockImplementation((filePath: string) =>
      filePath.endsWith('/other.json')
        ? {
            hostname: 'other',
            lastUpdated: 'synced-other',
            days: {
              '2024-01-01': {
                claude_code: {
                  byModel: { claude: { inputTokens: 100, outputTokens: 50 } },
                  totals: { inputTokens: 100, outputTokens: 50 },
                },
              },
            },
          }
        : {
            hostname: 'host',
            lastUpdated: 'synced-host',
            days: {
              '2024-01-02': {
                codex: {
                  byModel: { stale: { inputTokens: 999, outputTokens: 1 } },
                  totals: { inputTokens: 999, outputTokens: 1 },
                },
              },
              '2024-01-03': {
                codex: {
                  byModel: { archived: { inputTokens: 7, outputTokens: 1 } },
                  totals: { inputTokens: 7, outputTokens: 1 },
                },
              },
            },
          },
    );
    mocks.buildLocalMachineFile.mockResolvedValue({
      hostname: 'host',
      lastUpdated: 'now',
      days: {
        '2024-01-02': {
          codex: {
            byModel: { gpt: { inputTokens: 20, outputTokens: 10 } },
            totals: { inputTokens: 20, outputTokens: 10 },
          },
        },
      },
    });

    const loaded = await loadMergedProviderData({ providers: ['claude_code', 'codex'] });

    expect(mocks.readDataFile).toHaveBeenCalledTimes(2);
    expect(mocks.readDataFile.mock.calls[0]?.[0]).toBe('/repo/data/other.json');
    expect(loaded?.providerData.claude_code?.get('2024-01-01')?.inputTokens).toBe(100);
    // Fresh local data replaces the persisted copy of the same day...
    expect(loaded?.providerData.codex?.get('2024-01-02')?.inputTokens).toBe(20);
    // ...but a persisted day the local logs no longer reach is kept.
    expect(loaded?.providerData.codex?.get('2024-01-03')?.inputTokens).toBe(7);
    expect(loaded?.machineData).toHaveLength(2);
    expect(loaded?.machineData.map((machine) => machine.lastUpdated)).toEqual([
      'synced-other',
      'synced-host',
    ]);
  });

  it('uses exact basenames when replacing the persisted current machine', async () => {
    mocks.tryLoadConfig.mockReturnValue({
      repoUrl: 'git@example.com:me/data.git',
      machineId: 'host',
    });
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.isCloned.mockReturnValue(true);
    mocks.listDataFiles.mockReturnValue(['/repo/data/work-host.json', '/repo/data/host.json']);
    mocks.readDataFile.mockImplementation((filePath: string) => ({
      hostname: filePath.endsWith('/work-host.json') ? 'work-host' : 'host',
      lastUpdated: 'synced',
      days: {
        [filePath.endsWith('/work-host.json') ? '2024-01-01' : '2024-01-02']: {
          codex: {
            byModel: { gpt: { inputTokens: 10, outputTokens: 5 } },
            totals: { inputTokens: 10, outputTokens: 5 },
          },
        },
      },
    }));
    mocks.buildLocalMachineFile.mockResolvedValue({
      hostname: 'host',
      lastUpdated: 'fresh',
      days: {
        // Same date the current machine already has persisted, so the fresh
        // read must replace it rather than add to it.
        '2024-01-02': {
          codex: {
            byModel: { gpt: { inputTokens: 20, outputTokens: 10 } },
            totals: { inputTokens: 20, outputTokens: 10 },
          },
        },
      },
    });

    const loaded = await loadMergedProviderData({ providers: ['codex'] });

    // work-host.json is a different machine, so its day is untouched.
    expect(loaded?.providerData.codex?.get('2024-01-01')?.inputTokens).toBe(10);
    // Replaced, not summed: 20 rather than the persisted 10 + fresh 20.
    expect(loaded?.providerData.codex?.get('2024-01-02')?.inputTokens).toBe(20);
    expect(loaded?.machineData.map((machine) => machine.hostname)).toEqual(['work-host', 'host']);
  });

  it('falls back to persisted current-machine data when the local read is empty', async () => {
    mocks.tryLoadConfig.mockReturnValue({
      repoUrl: 'git@example.com:me/data.git',
      machineId: 'host',
    });
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.isCloned.mockReturnValue(true);
    mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
    mocks.readDataFile.mockReturnValue({
      hostname: 'host',
      lastUpdated: 'last-sync',
      days: {
        '2024-01-01': {
          claude_code: {
            byModel: { claude: { inputTokens: 30, outputTokens: 10 } },
            totals: { inputTokens: 30, outputTokens: 10 },
          },
        },
      },
    });
    mocks.buildLocalMachineFile.mockResolvedValue(emptyLocalMachine());

    const loaded = await loadMergedProviderData({ providers: ['claude_code'] });

    expect(loaded?.providerData.claude_code?.get('2024-01-01')?.inputTokens).toBe(30);
    expect(loaded?.machineData).toEqual([
      expect.objectContaining({ hostname: 'host', lastUpdated: 'last-sync' }),
    ]);
  });

  it('keeps persisted days the pruned local logs no longer cover', async () => {
    mocks.tryLoadConfig.mockReturnValue({
      repoUrl: 'git@example.com:me/data.git',
      machineId: 'host',
    });
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.isCloned.mockReturnValue(true);
    mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
    mocks.readDataFile.mockReturnValue({
      hostname: 'host',
      lastUpdated: 'last-sync',
      days: {
        '2024-01-01': {
          claude_code: {
            byModel: { claude: { inputTokens: 30, outputTokens: 10 } },
            totals: { inputTokens: 30, outputTokens: 10 },
          },
        },
        '2024-01-02': {
          codex: {
            byModel: { stale: { inputTokens: 900, outputTokens: 100 } },
            totals: { inputTokens: 900, outputTokens: 100 },
          },
        },
      },
    });
    mocks.buildLocalMachineFile.mockResolvedValue({
      hostname: 'host',
      lastUpdated: 'fresh',
      days: {
        '2024-01-03': {
          codex: {
            byModel: { fresh: { inputTokens: 20, outputTokens: 10 } },
            totals: { inputTokens: 20, outputTokens: 10 },
          },
        },
      },
    });

    const loaded = await loadMergedProviderData({ providers: ['claude_code', 'codex'] });

    expect(loaded?.providerData.claude_code?.get('2024-01-01')?.inputTokens).toBe(30);
    // The local codex logs have been pruned back to 2024-01-03, so the synced
    // file is the only remaining record of 2024-01-02 and must survive.
    expect(loaded?.providerData.codex?.get('2024-01-02')?.inputTokens).toBe(900);
    expect(loaded?.providerData.codex?.get('2024-01-03')?.inputTokens).toBe(20);
    expect(loaded?.machineData).toHaveLength(1);
    expect(loaded?.machineData[0]).toMatchObject({ hostname: 'host', lastUpdated: 'last-sync' });
    expect(loaded?.machineData[0]?.days).toHaveProperty('2024-01-01');
    expect(loaded?.machineData[0]?.days).toHaveProperty('2024-01-02');
  });
});
