import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeMachineFile, makeProviderDay } from '@aitrack/test-fixtures';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryLoadConfig: vi.fn(),
  resolveMachineId: vi.fn(),
  isCloned: vi.fn(),
  listDataFiles: vi.fn(),
  readDataFile: vi.fn(),
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
}));
// mergePersistedDays stays real: it is the rule sync persists with, and these
// tests assert display agrees with it.
vi.mock(import('../localData.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  buildLocalMachineFile: mocks.buildLocalMachineFile,
}));

import { ENCRYPTION_PASSPHRASE_ENV } from '../../store/encryption.js';
import type { DayEntry, ProviderDay } from '../types.js';
import {
  loadMergedProviderData,
  loadPersistedMachines,
  loadReportedMachines,
  machineUsageTotals,
  mergeProviderDay,
  providerDataForWindows,
} from '../usageData.js';

function emptyDay(): DayEntry {
  return { inputTokens: 0, outputTokens: 0, byModel: {} };
}

describe('mergeProviderDay', () => {
  it('sums the stored costs of projects and flags those without one', () => {
    const rec = emptyDay();
    const counts = { inputTokens: 10, outputTokens: 5 };
    const day: ProviderDay = {
      byModel: { m1: { ...counts, costUSD: 1 } },
      totals: { ...counts, costUSD: 1 },
      byProject: { 'a/b': { ...counts, costUSD: 1 }, 'c/d': counts },
      byCwd: { '/loose': counts },
    };
    mergeProviderDay(rec, 'claude_code', day);
    mergeProviderDay(rec, 'claude_code', day);
    expect(rec.byProject?.['a/b']).toEqual({ inputTokens: 20, outputTokens: 10, costUSD: 2 });
    expect(rec.byProject?.['c/d']).toMatchObject({ inputTokens: 20, hasUnpricedTokens: true });
    expect(rec.byCwd?.['/loose']?.inputTokens).toBe(20);
  });

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

  it('adds a backfilled model cost to a stored day total', () => {
    // The stored total covers m1 only; m2 has no cost yet and gets one
    // estimated here. Leaving the day total alone made the model table total
    // more than the day it belongs to, for the same underlying data.
    const rec = emptyDay();
    const pData: ProviderDay = {
      byModel: {
        m1: { inputTokens: 10, outputTokens: 5, costUSD: 0.5 },
        'claude-sonnet-4-6': { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      },
      totals: { inputTokens: 1_000_010, outputTokens: 1_000_005, costUSD: 0.5 },
    };

    mergeProviderDay(rec, 'claude_code', pData);

    const modelTotal =
      (rec.byModel.m1?.costUSD ?? 0) + (rec.byModel['claude-sonnet-4-6']?.costUSD ?? 0);
    expect(rec.costUSD).toBeCloseTo(18.5);
    expect(rec.costUSD).toBeCloseTo(modelTotal);
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

  it('clears a synced unpriced flag once the model is priced, but keeps stored partials', () => {
    const rec = emptyDay();
    mergeProviderDay(rec, 'claude_code', {
      byModel: {
        'claude-sonnet-4-6': {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          hasUnpricedTokens: true,
        },
      },
      totals: { inputTokens: 1_000_000, outputTokens: 1_000_000, hasUnpricedTokens: true },
    });
    expect(rec.hasUnpricedTokens).toBeUndefined();
    expect(rec.byModel['claude-sonnet-4-6']?.hasUnpricedTokens).toBeUndefined();

    mergeProviderDay(rec, 'claude_code', {
      byModel: { mixed: { inputTokens: 10, outputTokens: 0, costUSD: 1, hasUnpricedTokens: true } },
      totals: { inputTokens: 10, outputTokens: 0, costUSD: 1, hasUnpricedTokens: true },
    });
    expect(rec.hasUnpricedTokens).toBe(true);
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
    mocks.buildLocalMachineFile.mockResolvedValue(makeMachineFile('host'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('renders local-only when config is missing', async () => {
    mocks.buildLocalMachineFile.mockResolvedValue(
      makeMachineFile('host', { '2024-01-01': { claude_code: makeProviderDay(10, 5) } }),
    );

    const loaded = await loadMergedProviderData({
      providers: ['claude_code', 'codex'],
    });

    expect(console.warn).not.toHaveBeenCalled();
    expect(loaded?.providerData.claude_code?.get('2024-01-01')?.inputTokens).toBe(10);
    expect(loaded?.machineData).toEqual([]);
    expect(loaded?.warnedNotConfigured).toBe(true);
  });

  it('loadPersistedMachines lists synced files without reading the local logs', () => {
    mocks.listDataFiles.mockReturnValue(['/repo/data/other.json']);
    mocks.readDataFile.mockReturnValue(
      makeMachineFile('other', { '2024-01-01': { claude_code: makeProviderDay(10, 5) } }),
    );

    expect(loadPersistedMachines().map((entry) => entry.machine.hostname)).toEqual(['other']);
    expect(mocks.buildLocalMachineFile).not.toHaveBeenCalled();
  });

  describe('reading machine files in a long-lived process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitrack-machines-'));
    const file = join(dir, 'other.json');
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('re-reads a file only when it changed or the passphrase did', () => {
      mocks.listDataFiles.mockReturnValue([file]);
      mocks.readDataFile.mockImplementation(() => makeMachineFile('other'));
      vi.stubEnv(ENCRYPTION_PASSPHRASE_ENV, 'first');
      writeFileSync(file, '{}');

      loadPersistedMachines();
      loadPersistedMachines();
      expect(mocks.readDataFile).toHaveBeenCalledTimes(1);

      vi.stubEnv(ENCRYPTION_PASSPHRASE_ENV, 'second');
      loadPersistedMachines();
      expect(mocks.readDataFile).toHaveBeenCalledTimes(2);

      writeFileSync(file, '{ }');
      loadPersistedMachines();
      expect(mocks.readDataFile).toHaveBeenCalledTimes(3);
    });

    it('remembers a file that did not parse, until it changes', () => {
      mocks.listDataFiles.mockReturnValue([file]);
      mocks.readDataFile.mockReturnValue(null);
      writeFileSync(file, 'broken');

      expect(loadPersistedMachines()).toEqual([]);
      expect(loadPersistedMachines()).toEqual([]);
      expect(mocks.readDataFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('when configured and cloned', () => {
    beforeEach(() => {
      mocks.tryLoadConfig.mockReturnValue({
        repoUrl: 'git@example.com:me/data.git',
        machineId: 'host',
      });
      mocks.isCloned.mockReturnValue(true);
    });

    it('skips the local log read and reads synced files only once syncedReady resolves', async () => {
      mocks.readDataFile.mockReturnValue(
        makeMachineFile('other', { '2024-01-01': { claude_code: makeProviderDay(10, 5) } }),
      );
      const events: string[] = [];
      mocks.listDataFiles.mockImplementationOnce(() => {
        events.push('read');
        return ['/repo/data/other.json'];
      });
      const syncedReady = new Promise((resolve) => {
        setImmediate(() => {
          events.push('ready');
          resolve(undefined);
        });
      });

      const loaded = await loadMergedProviderData({
        providers: ['claude_code'],
        localMachine: null,
        syncedReady,
      });

      expect(events).toEqual(['ready', 'read']);
      expect(mocks.buildLocalMachineFile).not.toHaveBeenCalled();
      expect(loaded?.zonedSources.map((machine) => machine.hostname)).toEqual(['other']);
    });

    it('merges git data from other machines and overlays fresh local read', async () => {
      mocks.listDataFiles.mockReturnValue(['/repo/data/other.json', '/repo/data/host.json']);
      mocks.readDataFile.mockImplementation((filePath: string) =>
        filePath.endsWith('/other.json')
          ? makeMachineFile(
              'other',
              { '2024-01-01': { claude_code: makeProviderDay(100, 50) } },
              { lastUpdated: 'synced-other' },
            )
          : makeMachineFile(
              'host',
              {
                '2024-01-02': { codex: makeProviderDay(9, 1) },
                '2024-01-03': { codex: makeProviderDay(7, 1) },
              },
              { lastUpdated: 'synced-host' },
            ),
      );
      mocks.buildLocalMachineFile.mockResolvedValue(
        makeMachineFile('host', {
          '2024-01-02': { codex: makeProviderDay(20, 10) },
        }),
      );

      const loaded = await loadMergedProviderData({ providers: ['claude_code', 'codex'] });

      expect(mocks.readDataFile).toHaveBeenCalledTimes(2);
      expect(mocks.readDataFile.mock.calls[0]?.[0]).toBe('/repo/data/other.json');
      expect(loaded?.providerData.claude_code?.get('2024-01-01')?.inputTokens).toBe(100);
      // Fresh local data replaces the persisted copy of the same day...
      expect(loaded?.providerData.codex?.get('2024-01-02')?.inputTokens).toBe(20);
      // ...but a persisted day the local logs no longer reach is kept.
      expect(loaded?.providerData.codex?.get('2024-01-03')?.inputTokens).toBe(7);
      expect(loaded?.zonedSources).toHaveLength(2);
      expect(loaded?.zonedSources.map((machine) => machine.lastUpdated)).toEqual([
        'synced-other',
        'synced-host',
      ]);
    });

    it('uses exact basenames when replacing the persisted current machine', async () => {
      mocks.listDataFiles.mockReturnValue(['/repo/data/work-host.json', '/repo/data/host.json']);
      mocks.readDataFile.mockImplementation((filePath: string) => {
        const other = filePath.endsWith('/work-host.json');
        return makeMachineFile(
          other ? 'work-host' : 'host',
          {
            [other ? '2024-01-01' : '2024-01-02']: {
              codex: makeProviderDay(10, 5),
            },
          },
          { lastUpdated: 'synced' },
        );
      });
      // Same date the current machine already has persisted: replace, not add.
      mocks.buildLocalMachineFile.mockResolvedValue(
        makeMachineFile('host', {
          '2024-01-02': { codex: makeProviderDay(20, 10) },
        }),
      );

      const loaded = await loadMergedProviderData({ providers: ['codex'] });

      // work-host.json is a different machine, so its day is untouched.
      expect(loaded?.providerData.codex?.get('2024-01-01')?.inputTokens).toBe(10);
      // Replaced, not summed: 20 rather than the persisted 10 + fresh 20.
      expect(loaded?.providerData.codex?.get('2024-01-02')?.inputTokens).toBe(20);
      expect(loaded?.zonedSources.map((machine) => machine.hostname)).toEqual([
        'work-host',
        'host',
      ]);
      expect(
        loaded?.zonedSources.map(({ hostname, lastUpdated, current }) => ({
          hostname,
          lastUpdated,
          current,
        })),
      ).toEqual([
        { hostname: 'work-host', lastUpdated: 'synced', current: false },
        { hostname: 'host', lastUpdated: 'synced', current: true },
      ]);
    });

    it('falls back to persisted current-machine data when the local read is empty', async () => {
      mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
      mocks.readDataFile.mockReturnValue(
        makeMachineFile(
          'host',
          { '2024-01-01': { claude_code: makeProviderDay(30, 10) } },
          { lastUpdated: 'last-sync' },
        ),
      );

      const loaded = await loadMergedProviderData({ providers: ['claude_code'] });

      expect(loaded?.providerData.claude_code?.get('2024-01-01')?.inputTokens).toBe(30);
      expect(loaded?.zonedSources).toEqual([
        expect.objectContaining({ hostname: 'host', lastUpdated: 'last-sync' }),
      ]);
    });

    it('keeps the persisted boundary day when the local logs were pruned below it', async () => {
      mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
      mocks.readDataFile.mockReturnValue(
        makeMachineFile('host', {
          '2024-01-02': { claude_code: makeProviderDay(900_000, 100_000) },
        }),
      );
      // The day's transcripts have since been trimmed below what was synced.
      mocks.buildLocalMachineFile.mockResolvedValue(
        makeMachineFile('host', {
          '2024-01-02': { claude_code: makeProviderDay(180_000, 20_000) },
        }),
      );

      const loaded = await loadMergedProviderData({ providers: ['claude_code'] });

      // Display has to agree with sync, which keeps the larger persisted day.
      expect(loaded?.providerData.claude_code?.get('2024-01-02')?.inputTokens).toBe(900_000);
    });

    it('ignores a live provider day inside a synced file', async () => {
      mocks.listDataFiles.mockReturnValue(['/repo/data/other.json']);
      mocks.readDataFile.mockReturnValue(
        makeMachineFile('other', {
          '2024-01-01': { claude_code: makeProviderDay(1, 0), cursor: makeProviderDay(9, 0) },
        }),
      );

      const loaded = await loadMergedProviderData({ providers: ['claude_code', 'codex'] });
      const unfiltered = await loadMergedProviderData({ localMachine: makeMachineFile('host') });

      expect(loaded?.providerData.cursor).toBeUndefined();
      expect(unfiltered?.providerData.claude_code?.get('2024-01-01')?.inputTokens).toBe(1);
      expect(unfiltered?.providerData.cursor?.has('2024-01-01')).not.toBe(true);
    });

    it('counts a message once after this machine moved timezone, and labels it with the new one', async () => {
      mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
      mocks.readDataFile.mockReturnValue(
        makeMachineFile('host', { '2024-01-01': { claude_code: makeProviderDay(100, 0) } }),
      );
      mocks.buildLocalMachineFile.mockResolvedValue(
        makeMachineFile(
          'host',
          { '2024-01-02': { claude_code: makeProviderDay(100, 0) } },
          { timezone: 'Asia/Tokyo' },
        ),
      );

      const loaded = await loadMergedProviderData({ providers: ['claude_code'] });

      expect([...(loaded?.providerData.claude_code?.keys() ?? [])]).toEqual(['2024-01-02']);
      expect(loaded?.zonedSources[0]?.timezone).toBe('Asia/Tokyo');
    });
  });
});

describe('machineUsageTotals', () => {
  it('prices a stored day without a cost the way usage does', () => {
    const totals = machineUsageTotals(
      makeMachineFile('box', {
        '2026-01-03': { codex: makeProviderDay(1, 0, 0.5) },
        '2026-01-01': {
          claude_code: makeProviderDay(1_000_000, 1_000_000, undefined, 'claude-sonnet-4-6'),
        },
        '2026-01-02': { claude_code: makeProviderDay(0, 0), cursor: makeProviderDay(9, 0) },
      }),
    );
    expect(totals).toEqual({
      inputTokens: 1_000_001,
      outputTokens: 1_000_000,
      costUSD: 18.5,
      days: 2,
      firstDay: '2026-01-01',
      lastDay: '2026-01-03',
      providers: ['claude_code', 'codex'],
    });
  });

  it('reports no cost and flags the tokens when nothing could be priced', () => {
    const totals = machineUsageTotals(
      makeMachineFile('box', { '2026-01-01': { codex: makeProviderDay(5, 0) } }),
    );
    expect(totals).toMatchObject({ costUSD: null, hasUnpricedTokens: true });
    expect(machineUsageTotals(makeMachineFile('box'))).toMatchObject({
      costUSD: null,
      days: 0,
      firstDay: null,
      lastDay: null,
      providers: [],
    });
  });
});

describe('loadReportedMachines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryLoadConfig.mockReturnValue({
      repoUrl: 'git@example.com:me/data.git',
      machineId: 'host',
    });
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.isCloned.mockReturnValue(true);
    mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
  });

  it('overlays this machine with the local logs and keeps the sync timestamp', async () => {
    mocks.readDataFile.mockReturnValue(
      makeMachineFile(
        'host',
        { '2024-01-01': { claude_code: makeProviderDay(10, 0) } },
        { lastUpdated: 'last-sync' },
      ),
    );
    mocks.buildLocalMachineFile.mockResolvedValue(
      makeMachineFile('host', {
        '2024-01-02': { claude_code: makeProviderDay(40, 0) },
      }),
    );

    const machines = await loadReportedMachines();

    expect(machines[0]?.lastUpdated).toBe('last-sync');
    expect(machines[0]?.days['2024-01-01']?.claude_code?.totals.inputTokens).toBe(10);
    expect(machines[0]?.days['2024-01-02']?.claude_code?.totals.inputTokens).toBe(40);
  });

  it('shows this machine from its logs before sync is set up', async () => {
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);
    mocks.listDataFiles.mockClear();
    mocks.buildLocalMachineFile.mockResolvedValue(
      makeMachineFile('host', { '2024-01-02': { claude_code: makeProviderDay(40, 0) } }),
    );

    const machines = await loadReportedMachines();

    expect(machines.map((machine) => [machine.hostname, machine.lastUpdated])).toEqual([
      ['host', ''],
    ]);
    expect(mocks.listDataFiles).not.toHaveBeenCalled();
  });

  it('includes local-only usage as not yet synced', async () => {
    mocks.listDataFiles.mockReturnValue([]);
    mocks.buildLocalMachineFile.mockResolvedValue(
      makeMachineFile('host', {
        '2024-01-02': { claude_code: makeProviderDay(40, 0) },
      }),
    );

    const machines = await loadReportedMachines();

    expect(machines).toHaveLength(1);
    expect(machines[0]?.lastUpdated).toBe('');
    expect(machines[0]?.days['2024-01-02']?.claude_code?.totals.inputTokens).toBe(40);
  });
});

it('filters live-provider days using the viewer calendar while retaining zoned machine data', () => {
  const day = {
    inputTokens: 1,
    outputTokens: 2,
    byModel: { auto: { inputTokens: 1, outputTokens: 2 } },
  };
  const result = providerDataForWindows(
    {
      machineData: [],
      providerData: {},
      zonedSources: [],
      liveProviderData: {
        cursor: new Map([
          ['2026-01-01', day],
          ['2026-01-02', day],
        ]),
      },
    },
    () => ({ start: '2026-01-01', end: '2026-01-01' }),
  );
  expect([...(result.cursor?.keys() ?? [])]).toEqual(['2026-01-01']);
});
