import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DayEntry } from '../../data/types.js';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('../../data/usageData.js', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
  emptyUsageMessage: () => 'No data.',
}));
vi.mock('../../config.js', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('../../git.js', () => ({ isCloned: mocks.isCloned }));

import { topCommand } from '../top.js';

function makeDay(input: number, output: number, cost: number | undefined, model: string): DayEntry {
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cost !== undefined && { costUSD: cost }),
    byModel: {
      [model]: {
        inputTokens: input,
        outputTokens: output,
        ...(cost !== undefined && { costUSD: cost }),
      },
    },
  };
}

function captured(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

describe('topCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.isCloned.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('days: ranks busiest days by cost across providers', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-01-01', makeDay(1000, 0, 10, 'opus')],
          ['2026-01-02', makeDay(100, 0, 1, 'opus')],
        ]),
        codex: new Map([['2026-01-01', makeDay(500, 0, 5, 'gpt-5')]]),
      },
      machineData: [],
      fileCount: 0,
    });

    await topCommand({ kind: 'days', limit: 2, sort: 'cost' });

    const out = captured();
    expect(out).toContain('Top 2 days by cost');
    const jan1Index = out.indexOf('2026-01-01');
    const jan2Index = out.indexOf('2026-01-02');
    expect(jan1Index).toBeGreaterThan(-1);
    expect(jan2Index).toBeGreaterThan(jan1Index);
  });

  it('models: ranks top models by tokens', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-01-01', makeDay(900, 100, 5, 'opus')],
          ['2026-01-02', makeDay(50, 50, 0.5, 'sonnet')],
        ]),
      },
      machineData: [],
      fileCount: 0,
    });

    await topCommand({ kind: 'models', limit: 5, sort: 'tokens' });

    const out = captured();
    expect(out).toContain('Top 5 models by tokens');
    const opusIndex = out.indexOf('opus');
    const sonnetIndex = out.indexOf('sonnet');
    expect(opusIndex).toBeGreaterThan(-1);
    expect(sonnetIndex).toBeGreaterThan(opusIndex);
  });

  it('respects year filter', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-01-01', makeDay(100, 0, 1, 'm1')],
          ['2025-01-01', makeDay(9999, 0, 99, 'm1')],
        ]),
      },
      machineData: [],
      fileCount: 0,
    });

    await topCommand({ kind: 'days', limit: 10, sort: 'tokens', year: 2026 });

    const out = captured();
    expect(out).toContain('2026-01-01');
    expect(out).not.toContain('2025-01-01');
  });

  it('emits empty message on no data', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);

    await topCommand({ kind: 'models', limit: 5, sort: 'cost' });

    expect(captured()).toContain('No data.');
  });
});
