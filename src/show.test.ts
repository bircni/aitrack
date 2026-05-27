import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryLoadConfig: vi.fn(),
  resolveMachineId: vi.fn(),
  isCloned: vi.fn(),
  pull: vi.fn(),
  tryPull: vi.fn(),
  listDataFiles: vi.fn(),
  readDataFile: vi.fn(),
  writePendingMachineFile: vi.fn(),
  buildLocalMachineFile: vi.fn(),
  readCursorData: vi.fn(),
  renderToPng: vi.fn(),
  writeFileSync: vi.fn(),
  exec: vi.fn(),
  hostname: vi.fn(),
}));

vi.mock('fs', () => ({ writeFileSync: mocks.writeFileSync }));
vi.mock('child_process', () => ({ exec: mocks.exec }));
vi.mock('os', () => ({ hostname: mocks.hostname }));
vi.mock('./config.js', () => ({
  tryLoadConfig: mocks.tryLoadConfig,
  resolveMachineId: mocks.resolveMachineId,
}));
vi.mock('./git.js', () => ({
  isCloned: mocks.isCloned,
  pull: mocks.pull,
  tryPull: mocks.tryPull,
  listDataFiles: mocks.listDataFiles,
  readDataFile: mocks.readDataFile,
  writePendingMachineFile: mocks.writePendingMachineFile,
}));
vi.mock('./localData.js', () => ({
  buildLocalMachineFile: mocks.buildLocalMachineFile,
  machineHasData: (machine: { days: Record<string, unknown> }) =>
    Object.keys(machine.days).length > 0,
}));
vi.mock('./readers/cursor.js', () => ({ readCursorData: mocks.readCursorData }));
vi.mock('./render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./render.js')>();
  return {
    ...actual,
    renderToPng: mocks.renderToPng,
  };
});

import {
  emptyUsageMessage,
  loadMergedProviderData,
  mergeProviderDay,
  showCommand,
} from './show.js';
import type { DayEntry, MachineFile, ProviderData, ProviderDay, RenderOptions } from './types.js';

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
        m2: { inputTokens: 20, outputTokens: 7, costUSD: 1.0 },
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
    mocks.hostname.mockReturnValue('host');
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);
    mocks.buildLocalMachineFile.mockResolvedValue(emptyLocalMachine());
    mocks.readCursorData.mockResolvedValue(new Map());
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

    const loaded = await loadMergedProviderData({ noCursor: true });

    expect(console.warn).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.tryPull).not.toHaveBeenCalled();
    expect(mocks.writePendingMachineFile).toHaveBeenCalled();
    expect(loaded?.providerData.claude_code?.get('2024-01-01')?.inputTokens).toBe(10);
    expect(loaded?.warnedNotConfigured).toBe(true);
  });

  it('merges git data from other machines and overlays fresh local read', async () => {
    mocks.tryLoadConfig.mockReturnValue({
      repoUrl: 'git@example.com:me/data.git',
      machineId: 'host',
    });
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.isCloned.mockReturnValue(true);
    mocks.listDataFiles.mockReturnValue(['/repo/data/other.json', '/repo/data/host.json']);
    mocks.readDataFile.mockReturnValue({
      hostname: 'other',
      lastUpdated: 'now',
      days: {
        '2024-01-01': {
          claude_code: {
            byModel: { claude: { inputTokens: 100, outputTokens: 50 } },
            totals: { inputTokens: 100, outputTokens: 50 },
          },
        },
      },
    });
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

    const loaded = await loadMergedProviderData({ noCursor: true });

    expect(mocks.readDataFile).toHaveBeenCalledTimes(1);
    expect(mocks.readDataFile.mock.calls[0]?.[0]).toBe('/repo/data/other.json');
    expect(loaded?.providerData.claude_code?.get('2024-01-01')?.inputTokens).toBe(100);
    expect(loaded?.providerData.codex?.get('2024-01-02')?.inputTokens).toBe(20);
    expect(loaded?.machineData).toHaveLength(2);
  });
});

describe('showCommand', () => {
  function getRenderCall(): [ProviderData, MachineFile[], RenderOptions] {
    const call = mocks.renderToPng.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('expected renderToPng to be called');
    return call as [ProviderData, MachineFile[], RenderOptions];
  }

  function getRenderedProviderData(): ProviderData {
    return getRenderCall()[0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostname.mockReturnValue('host');
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.isCloned.mockReturnValue(true);
    mocks.listDataFiles.mockReturnValue([]);
    mocks.buildLocalMachineFile.mockResolvedValue(emptyLocalMachine());
    mocks.readCursorData.mockResolvedValue(new Map());
    mocks.renderToPng.mockReturnValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('does not throw when the repo has not been cloned', async () => {
    mocks.isCloned.mockReturnValue(false);

    await showCommand();

    expect(console.warn).not.toHaveBeenCalled();
    expect(mocks.renderToPng).not.toHaveBeenCalled();
  });

  it('prints the init hint when not configured and no local data exists', async () => {
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);

    await showCommand();

    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(emptyUsageMessage(true));
  });

  it('prints the sync hint when configured but no git or local data exists', async () => {
    await showCommand();

    expect(console.log).toHaveBeenCalledWith(emptyUsageMessage(false));
  });

  it('renders cursor-only data when local cursor data is available', async () => {
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);
    mocks.readCursorData.mockResolvedValue(
      new Map([
        [
          '2024-01-01',
          {
            inputTokens: 10,
            outputTokens: 5,
            byModel: { cursor: { inputTokens: 10, outputTokens: 5 } },
          },
        ],
      ]),
    );

    await showCommand({ output: 'out.png', dark: true, all: true });

    const [providerData, machineData, renderOptions] = getRenderCall();
    expect(providerData.all).toBeInstanceOf(Map);
    expect(machineData).toEqual([]);
    expect(renderOptions).toEqual({ dark: true, all: true, year: undefined });
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('out.png'),
      expect.any(Buffer),
    );
    expect(mocks.exec).toHaveBeenCalled();
  });

  it('backfills cost for old synced Claude JSON missing costUSD', async () => {
    mocks.listDataFiles.mockReturnValue(['/repo/data/old.json']);
    mocks.readDataFile.mockReturnValue({
      hostname: 'other',
      lastUpdated: 'now',
      days: {
        '2024-01-01': {
          claude_code: {
            byModel: { 'claude-sonnet-4': { inputTokens: 1_000_000, outputTokens: 100_000 } },
            totals: { inputTokens: 1_000_000, outputTokens: 100_000 },
          },
        },
      },
    });

    await showCommand({ noCursor: true });

    const providerData = getRenderedProviderData();
    const day = providerData.claude_code.get('2024-01-01');
    expect(day?.costUSD).toBeCloseTo(4.5, 5);
    expect(day?.byModel['claude-sonnet-4'].costUSD).toBeCloseTo(4.5, 5);
  });

  it('merges synced cost fields across machines and models', async () => {
    mocks.listDataFiles.mockReturnValue(['/repo/data/a.json', '/repo/data/b.json']);
    mocks.readDataFile
      .mockReturnValueOnce({
        hostname: 'a',
        lastUpdated: 'now',
        days: {
          '2024-01-01': {
            claude_code: {
              byModel: { claude: { inputTokens: 10, outputTokens: 5, costUSD: 0.1 } },
              totals: { inputTokens: 10, outputTokens: 5, costUSD: 0.1 },
            },
          },
        },
      })
      .mockReturnValueOnce({
        hostname: 'b',
        lastUpdated: 'now',
        days: {
          '2024-01-01': {
            claude_code: {
              byModel: { claude: { inputTokens: 20, outputTokens: 10, costUSD: 0.2 } },
              totals: { inputTokens: 20, outputTokens: 10, costUSD: 0.2 },
            },
          },
        },
      });

    await showCommand({ noCursor: true });

    const providerData = getRenderedProviderData();
    const day = providerData.claude_code.get('2024-01-01');
    expect(day?.costUSD).toBeCloseTo(0.3);
    expect(day?.byModel.claude.costUSD).toBeCloseTo(0.3);
  });
});
