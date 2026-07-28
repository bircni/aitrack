import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MachineFile } from '../../data/types.js';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('../../data/usageData.js', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
  usageEmptyMessage: () => 'No data.',
}));
vi.mock('../../config.js', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('../../git.js', () => ({ isCloned: mocks.isCloned }));

import { machinesCommand } from '../machines.js';

function captured(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

function makeMachine(
  hostname: string,
  days: Record<
    string,
    Array<{ providerKey: string; input: number; output: number; cost?: number }>
  >,
): MachineFile {
  const out: MachineFile = {
    hostname,
    lastUpdated: '2026-04-01T12:00:00.000Z',
    days: {},
  };
  for (const [date, items] of Object.entries(days)) {
    const dayProviders: MachineFile['days'][string] = {};
    for (const item of items) {
      dayProviders[item.providerKey] = {
        byModel: {
          m: {
            inputTokens: item.input,
            outputTokens: item.output,
            ...(item.cost !== undefined && { costUSD: item.cost }),
          },
        },
        totals: {
          inputTokens: item.input,
          outputTokens: item.output,
          ...(item.cost !== undefined && { costUSD: item.cost }),
        },
      };
    }
    out.days[date] = dayProviders;
  }
  return out;
}

describe('machinesCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.isCloned.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('prints a table of machines sorted by tokens desc', async () => {
    const a = makeMachine('big', {
      '2026-01-01': [{ providerKey: 'claude_code', input: 1000, output: 100, cost: 5 }],
    });
    const b = makeMachine('small', {
      '2026-01-01': [{ providerKey: 'codex', input: 50, output: 5 }],
    });
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {},
      machineData: [b, a],
    });

    await machinesCommand();

    const out = captured();
    expect(out).toContain('aitrack machines (2)');
    const bigIndex = out.indexOf('big');
    const smallIndex = out.indexOf('small');
    expect(bigIndex).toBeGreaterThan(-1);
    expect(smallIndex).toBeGreaterThan(bigIndex);
    expect(out).toContain('Claude Code');
    expect(out).toContain('Codex');
  });

  it('prints JSON when requested', async () => {
    const machine = makeMachine('box', {
      '2026-01-01': [{ providerKey: 'claude_code', input: 1000, output: 100, cost: 5 }],
    });
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {},
      machineData: [machine],
    });

    await machinesCommand({ json: true });

    const parsed = JSON.parse(captured()) as {
      command: string;
      machines: Array<{ hostname: string; totalTokens: number; costUSD: number }>;
    };
    expect(parsed.command).toBe('machines');
    expect(parsed.machines[0]).toMatchObject({
      hostname: 'box',
      totalTokens: 1100,
      costUSD: 5,
    });
  });

  it('shows empty message when no machine data', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {},
      machineData: [],
    });

    await machinesCommand();

    expect(captured()).toContain('No data.');
  });

  it('prints valid JSON when no machine data exists', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {},
      machineData: [],
    });

    await machinesCommand({ json: true });

    expect(JSON.parse(captured())).toMatchObject({
      command: 'machines',
      machines: [],
      message: 'No data.',
    });
  });
});
