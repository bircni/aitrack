import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('./show.js', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
  emptyUsageMessage: (warned?: boolean) =>
    warned ? 'No local usage data found.' : 'No usage data found.',
}));
vi.mock('./config.js', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('./git.js', () => ({ isCloned: mocks.isCloned }));

import { summaryCommand } from './summary.js';

describe('summaryCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.isCloned.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('prints monthly totals for merged provider data', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          [
            '2024-01-15',
            {
              inputTokens: 1000,
              outputTokens: 200,
              costUSD: 1.2,
              byModel: {
                'claude-sonnet-4': { inputTokens: 1000, outputTokens: 200, costUSD: 1.2 },
              },
            },
          ],
          [
            '2024-02-01',
            {
              inputTokens: 500,
              outputTokens: 100,
              costUSD: 0.6,
              byModel: {
                'claude-sonnet-4': { inputTokens: 500, outputTokens: 100, costUSD: 0.6 },
              },
            },
          ],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await summaryCommand({ noCursor: true });

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
    expect(output).toContain('Claude Code');
    expect(output).toContain('2024-01');
    expect(output).toContain('2024-02');
    expect(output).toContain('TOTAL');
  });

  it('passes year filter through to loadMergedProviderData', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);

    await summaryCommand({ noCursor: true, year: 2024 });

    expect(mocks.loadMergedProviderData).toHaveBeenCalledWith({ noCursor: true, year: 2024 });
  });

  it('prints empty hint when no data is loaded', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);

    await summaryCommand({ noCursor: true });

    expect(console.log).toHaveBeenCalledWith('No local usage data found.');
  });
});
