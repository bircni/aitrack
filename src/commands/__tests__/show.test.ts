import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loggedOutput } from '../../__tests__/helpers/fixtures.js';

const mocks = vi.hoisted(() => ({
  tryLoadConfig: vi.fn(),
  resolveMachineId: vi.fn(),
  isCloned: vi.fn(),
  listDataFiles: vi.fn(),
  readDataFile: vi.fn(),
  writePendingMachineFile: vi.fn(),
  buildLocalMachineFile: vi.fn(),
  readCursorData: vi.fn(),
  renderToPng: vi.fn(),
  writeFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  hostname: vi.fn(),
}));

vi.mock('fs', () => ({ writeFileSync: mocks.writeFileSync }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('os', () => ({ hostname: mocks.hostname }));
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
vi.mock('../../data/localData.js', () => ({
  buildLocalMachineFile: mocks.buildLocalMachineFile,
  machineHasData: (machine: { days: Record<string, unknown> }) =>
    Object.keys(machine.days).length > 0,
}));
vi.mock('../../readers/cursor/index.js', () => ({ readCursorData: mocks.readCursorData }));
vi.mock('../../display/renderPng.js', () => ({ renderToPng: mocks.renderToPng }));

import type { MachineFile, ProviderData } from '../../data/types.js';
import type { RenderOptions } from '../../display/renderOptions.js';
import { showCommand } from '../show.js';

function emptyLocalMachine(host = 'host'): MachineFile {
  return { hostname: host, lastUpdated: 'now', days: {} };
}

function localMachineWithData(host = 'host'): MachineFile {
  return {
    hostname: host,
    lastUpdated: 'now',
    days: {
      '2024-01-01': {
        codex: {
          byModel: { 'gpt-5': { inputTokens: 10, outputTokens: 5 } },
          totals: { inputTokens: 10, outputTokens: 5 },
        },
      },
    },
  };
}

function withPlatform(platform: NodeJS.Platform, callback: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  return callback().finally(() => {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  });
}

describe('showCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  function getRenderCall(): [ProviderData, RenderOptions] {
    const call = mocks.renderToPng.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('expected renderToPng to be called');
    return call as [ProviderData, RenderOptions];
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
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
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
    expect(logSpy).toHaveBeenCalledWith(
      'No local usage data found (Claude Code or Codex). Run: npx aitrack init to sync across machines.',
    );
  });

  it('prints the sync hint when configured but no git or local data exists', async () => {
    await showCommand();

    expect(logSpy).toHaveBeenCalledWith(
      'No usage data found. Run: npx aitrack sync (Claude/Codex), or use Cursor locally.',
    );
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

    const [providerData, renderOptions] = getRenderCall();
    expect(providerData.cursor).toBeInstanceOf(Map);
    expect(renderOptions).toEqual({ dark: true, all: true, year: undefined });
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('out.png'),
      expect.any(Buffer),
    );
    expect(mocks.spawn).toHaveBeenCalled();
  });

  it('opens generated files with platform-specific commands', async () => {
    mocks.buildLocalMachineFile.mockResolvedValue(localMachineWithData());

    await withPlatform('win32', () => showCommand({ output: 'out.png' }));
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      'cmd',
      ['/c', 'start', '', expect.stringContaining('out.png')],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );

    mocks.spawn.mockClear();
    await withPlatform('linux', () => showCommand({ output: 'out.png' }));
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      'xdg-open',
      [expect.stringContaining('out.png')],
      expect.objectContaining({ detached: true }),
    );
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

    await showCommand({ providers: ['claude_code', 'codex'] });

    const providerData = getRenderedProviderData();
    const day = providerData.claude_code?.get('2024-01-01');
    expect(day?.costUSD).toBeCloseTo(4.5, 5);
    expect(day?.byModel['claude-sonnet-4']?.costUSD).toBeCloseTo(4.5, 5);
  });

  it('renders a terminal table and skips PNG generation when --tui is set', async () => {
    mocks.listDataFiles.mockReturnValue(['/repo/data/other.json']);
    mocks.readDataFile.mockReturnValue({
      hostname: 'other',
      lastUpdated: 'now',
      days: {
        '2024-01-01': {
          claude_code: {
            byModel: { 'claude-sonnet-4': { inputTokens: 1000, outputTokens: 500, costUSD: 1.5 } },
            totals: { inputTokens: 1000, outputTokens: 500, costUSD: 1.5 },
          },
        },
      },
    });

    await showCommand({ tui: true, providers: ['claude_code', 'codex'] });

    expect(mocks.renderToPng).not.toHaveBeenCalled();
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    const out = loggedOutput();
    expect(out).toContain('aitrack stats');
    expect(out).toContain('Claude Code');
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

    await showCommand({ providers: ['claude_code', 'codex'] });

    const providerData = getRenderedProviderData();
    const day = providerData.claude_code?.get('2024-01-01');
    expect(day?.costUSD).toBeCloseTo(0.3);
    expect(day?.byModel.claude?.costUSD).toBeCloseTo(0.3);
  });
});
