import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readClaudeData: vi.fn(),
  readCodexData: vi.fn(),
  isCloned: vi.fn(),
  pull: vi.fn(),
  commitAndPush: vi.fn(),
  hasMachineDataChanges: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  hostname: vi.fn(),
}));

vi.mock('os', () => ({ hostname: mocks.hostname }));
vi.mock('fs', () => ({
  mkdirSync: mocks.mkdirSync,
  writeFileSync: mocks.writeFileSync,
  readFileSync: mocks.readFileSync,
}));
vi.mock('../../config.js', () => ({
  loadConfig: mocks.loadConfig,
  resolveMachineId: (config: { machineId?: string }) => config.machineId ?? 'host',
}));
vi.mock('../../readers/claude.js', () => ({ readClaudeData: mocks.readClaudeData }));
vi.mock('../../readers/codex.js', () => ({ readCodexData: mocks.readCodexData }));
vi.mock('../../data/localData.js', async () => ({
  // The real merge helper — this is what keeps pruned-away history in the file.
  mergePersistedDays: (
    await vi.importActual<typeof import('../../data/localData.js')>('../../data/localData.js')
  ).mergePersistedDays,
  buildMachineData: (host: string, providers: Record<string, DayMap>) => {
    const days: Record<string, Record<string, unknown>> = {};
    for (const [providerKey, dayMap] of Object.entries(providers)) {
      for (const [date, day] of dayMap) {
        days[date] ??= {};
        days[date][providerKey] = {
          byModel: day.byModel,
          totals: { inputTokens: day.inputTokens, outputTokens: day.outputTokens },
        };
      }
    }
    return { hostname: host, lastUpdated: 'now', days };
  },
  readLocalProviderMaps: async (): Promise<{ claude_code: DayMap; codex: DayMap }> => ({
    claude_code: (await mocks.readClaudeData()) as DayMap,
    codex: (await mocks.readCodexData()) as DayMap,
  }),
}));
vi.mock('../../git.js', () => ({
  LOCAL_REPO: '/repo',
  isCloned: mocks.isCloned,
  pull: mocks.pull,
  commitAndPush: mocks.commitAndPush,
  hasMachineDataChanges: mocks.hasMachineDataChanges,
  removePendingMachineFile: vi.fn(),
}));

import type { DayMap } from '../../data/types.js';
import { syncCommand, syncData } from '../sync.js';

function dayMap(inputTokens: number, outputTokens: number, model = 'model'): DayMap {
  return new Map([
    [
      '2024-01-01',
      { inputTokens, outputTokens, byModel: { [model]: { inputTokens, outputTokens } } },
    ],
  ]);
}

describe('syncCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCloned.mockReturnValue(true);
    mocks.loadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.hostname.mockReturnValue('host');
    mocks.readClaudeData.mockResolvedValue(new Map());
    mocks.readCodexData.mockResolvedValue(new Map());
    mocks.commitAndPush.mockReturnValue(false);
    mocks.hasMachineDataChanges.mockReturnValue(false);
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('missing');
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('throws when the repo has not been cloned', async () => {
    mocks.isCloned.mockReturnValue(false);

    await expect(syncCommand()).rejects.toThrow('Repo not cloned');
  });

  it('writes codex-only data and pushes it', async () => {
    mocks.readCodexData.mockResolvedValue(dayMap(20, 10, 'gpt-5'));

    await syncCommand();

    expect(console.log).toHaveBeenCalledWith('Found: Codex (1 days)');
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('host.json'),
      expect.stringContaining('"codex"'),
      'utf8',
    );
    expect(mocks.commitAndPush).toHaveBeenCalledWith('host');
  });

  it('keeps persisted days that the local logs have already pruned', async () => {
    // Local logs only reach back to 2024-01-01; the synced file is the only
    // record of 2023-06-01 and must survive the write.
    mocks.readCodexData.mockResolvedValue(dayMap(20, 10, 'gpt-5'));
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        hostname: 'host',
        lastUpdated: 'old',
        days: {
          '2023-06-01': {
            codex: {
              byModel: { 'gpt-5': { inputTokens: 900, outputTokens: 100 } },
              totals: { inputTokens: 900, outputTokens: 100 },
            },
          },
        },
      }),
    );

    await syncCommand();

    const written = mocks.writeFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as { days: Record<string, unknown> };
    expect(Object.keys(parsed.days)).toEqual(['2023-06-01', '2024-01-01']);
  });

  it('pushes a pending machine migration when no local usage remains', async () => {
    mocks.commitAndPush.mockReturnValue(true);
    mocks.hasMachineDataChanges.mockReturnValue(true);

    await syncCommand();

    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.commitAndPush).toHaveBeenCalledWith('host');
    expect(console.log).toHaveBeenCalledWith('Done! Pushed machine data migration for host.');
  });

  it('uses a configured machineId for the data filename', async () => {
    mocks.loadConfig.mockReturnValue({
      repoUrl: 'git@example.com:me/data.git',
      machineId: 'work-laptop',
    });
    mocks.readCodexData.mockResolvedValue(dayMap(20, 10, 'gpt-5'));

    await syncCommand();

    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('work-laptop.json'),
      expect.any(String),
      'utf8',
    );
    expect(mocks.commitAndPush).toHaveBeenCalledWith('work-laptop');
  });

  it('rejects an unsafe configured machineId before writing a data file', async () => {
    mocks.loadConfig.mockReturnValue({
      repoUrl: 'git@example.com:me/data.git',
      machineId: '../../escape',
    });
    mocks.readCodexData.mockResolvedValue(dayMap(20, 10, 'gpt-5'));

    await expect(syncCommand()).rejects.toThrow('Machine name');

    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.commitAndPush).not.toHaveBeenCalled();
  });

  it('syncData with quiet suppresses progress logs', async () => {
    mocks.readCodexData.mockResolvedValue(dayMap(20, 10, 'gpt-5'));

    await syncData({ quiet: true });

    expect(console.log).not.toHaveBeenCalled();
    expect(mocks.writeFileSync).toHaveBeenCalled();
    expect(mocks.commitAndPush).toHaveBeenCalledWith('host');
  });

  it('dry-runs without pulling, writing, committing, or cleaning pending data', async () => {
    mocks.readCodexData.mockResolvedValue(dayMap(20, 10, 'gpt-5'));

    await syncCommand({ dryRun: true });

    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.mkdirSync).not.toHaveBeenCalled();
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.commitAndPush).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      'Dry run: would create data/host.json (1 days). No changes written.',
    );
  });

  it('does not commit unrelated data changes when the matching current target is clean', async () => {
    const existing = {
      hostname: 'host',
      lastUpdated: 'old',
      days: {
        '2024-01-01': {
          claude_code: {
            byModel: { claude: { inputTokens: 30, outputTokens: 15 } },
            totals: { inputTokens: 30, outputTokens: 15 },
          },
        },
      },
    };
    mocks.readClaudeData.mockResolvedValue(dayMap(30, 15, 'claude'));
    mocks.readFileSync.mockReturnValue(JSON.stringify(existing));

    await syncCommand();

    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.hasMachineDataChanges).toHaveBeenCalledWith('host');
    expect(mocks.commitAndPush).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('No changes to push — data is already up to date.');
  });

  it('pushes a pending machine rename even when usage data already matches', async () => {
    const existing = {
      hostname: 'new-host',
      lastUpdated: 'old',
      days: {
        '2024-01-01': {
          codex: {
            byModel: { 'gpt-5': { inputTokens: 20, outputTokens: 10 } },
            totals: { inputTokens: 20, outputTokens: 10 },
          },
        },
      },
    };
    mocks.loadConfig.mockReturnValue({
      repoUrl: 'git@example.com:me/data.git',
      machineId: 'new-host',
    });
    mocks.readCodexData.mockResolvedValue(dayMap(20, 10, 'gpt-5'));
    mocks.readFileSync.mockReturnValue(JSON.stringify(existing));
    mocks.commitAndPush.mockReturnValue(true);
    mocks.hasMachineDataChanges.mockReturnValue(true);

    await syncCommand();

    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.commitAndPush).toHaveBeenCalledWith('new-host');
    expect(console.log).toHaveBeenCalledWith('Done! Pushed data/new-host.json (1 days)');
  });
});
