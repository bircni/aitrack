import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toLocalDateString } from './dayMap.js';

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

import { todayCommand } from './today.js';

const TODAY = toLocalDateString(new Date());

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

describe('todayCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.isCloned.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it("prints today's per-model rows and a TOTAL", async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          [
            TODAY,
            {
              inputTokens: 1000,
              outputTokens: 200,
              costUSD: 1.2,
              byModel: {
                'claude-opus-4-8': { inputTokens: 800, outputTokens: 100, costUSD: 1.0 },
                'claude-sonnet-4-6': { inputTokens: 200, outputTokens: 100, costUSD: 0.2 },
              },
            },
          ],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await todayCommand({ noCursor: true });

    const out = output();
    expect(out).toContain(TODAY);
    expect(out).toContain('Claude Code');
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('claude-sonnet-4-6');
    expect(out).toContain('TOTAL');
    expect(out).toContain('$1.20');
  });

  it('prints a no-usage message when there is no entry for today', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          [
            '2020-01-01',
            {
              inputTokens: 1000,
              outputTokens: 200,
              costUSD: 1.2,
              byModel: {
                'claude-sonnet-4-6': { inputTokens: 1000, outputTokens: 200, costUSD: 1.2 },
              },
            },
          ],
        ]),
      },
      machineData: [],
      fileCount: 1,
    });

    await todayCommand({ noCursor: true });

    expect(output()).toContain(`No usage recorded today (${TODAY}).`);
  });

  it('prints empty hint when no data is loaded', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);

    await todayCommand({ noCursor: true });

    expect(console.log).toHaveBeenCalledWith('No local usage data found.');
  });
});
