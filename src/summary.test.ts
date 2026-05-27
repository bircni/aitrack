import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  isCloned: vi.fn(),
  pull: vi.fn(),
  listDataFiles: vi.fn(),
  readDataFile: vi.fn(),
  readCursorData: vi.fn(),
}));

vi.mock('./config.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('./git.js', () => ({
  isCloned: mocks.isCloned,
  pull: mocks.pull,
  listDataFiles: mocks.listDataFiles,
  readDataFile: mocks.readDataFile,
}));
vi.mock('./readers/cursor.js', () => ({ readCursorData: mocks.readCursorData }));

import { summaryCommand } from './summary.js';

describe('summaryCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCloned.mockReturnValue(true);
    mocks.listDataFiles.mockReturnValue([]);
    mocks.readDataFile.mockReturnValue(null);
    mocks.readCursorData.mockResolvedValue(new Map());
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('throws when the repo has not been cloned', async () => {
    mocks.isCloned.mockReturnValue(false);
    await expect(summaryCommand()).rejects.toThrow('Repo not cloned');
  });

  it('prints monthly totals for synced providers', async () => {
    mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
    mocks.readDataFile.mockReturnValue({
      hostname: 'host',
      lastUpdated: 'now',
      days: {
        '2024-01-15': {
          claude_code: {
            byModel: { 'claude-sonnet-4': { inputTokens: 1000, outputTokens: 200, costUSD: 1.2 } },
            totals: { inputTokens: 1000, outputTokens: 200, costUSD: 1.2 },
          },
        },
        '2024-02-01': {
          claude_code: {
            byModel: { 'claude-sonnet-4': { inputTokens: 500, outputTokens: 100, costUSD: 0.6 } },
            totals: { inputTokens: 500, outputTokens: 100, costUSD: 0.6 },
          },
        },
      },
    });

    await summaryCommand({ noCursor: true, noPull: true });

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
    expect(output).toContain('Claude Code');
    expect(output).toContain('2024-01');
    expect(output).toContain('2024-02');
    expect(output).toContain('TOTAL');
  });

  it('respects year filter', async () => {
    mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
    mocks.readDataFile.mockReturnValue({
      hostname: 'host',
      lastUpdated: 'now',
      days: {
        '2024-01-15': {
          claude_code: {
            byModel: { 'claude-sonnet-4': { inputTokens: 1000, outputTokens: 200 } },
            totals: { inputTokens: 1000, outputTokens: 200 },
          },
        },
        '2025-01-15': {
          claude_code: {
            byModel: { 'claude-sonnet-4': { inputTokens: 9000, outputTokens: 800 } },
            totals: { inputTokens: 9000, outputTokens: 800 },
          },
        },
      },
    });

    await summaryCommand({ noCursor: true, noPull: true, year: 2024 });

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
    expect(output).toContain('2024-01');
    expect(output).not.toContain('2025-01');
  });
});
