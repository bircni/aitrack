import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeDay, loggedOutput } from '../../__tests__/helpers/fixtures.js';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('../../data/usageData.js', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
  usageEmptyMessage: () => 'No data.',
  usageEmptyWindowMessage: () => 'No usage recorded.',
}));
vi.mock('../../config.js', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('../../git.js', () => ({ isCloned: mocks.isCloned }));

import { topCommand } from '../top.js';

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
    });

    await topCommand({ kind: 'days', limit: 2, sort: 'cost' });

    const out = loggedOutput();
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
    });

    await topCommand({ kind: 'models', limit: 5, sort: 'tokens' });

    const out = loggedOutput();
    expect(out).toContain('Top 5 models by tokens');
    const opusIndex = out.indexOf('opus');
    const sonnetIndex = out.indexOf('sonnet');
    expect(opusIndex).toBeGreaterThan(-1);
    expect(sonnetIndex).toBeGreaterThan(opusIndex);
  });

  it('prints JSON when requested', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([['2026-01-01', makeDay(900, 100, 5, 'opus')]]),
      },
      machineData: [],
    });

    await topCommand({ kind: 'models', limit: 5, sort: 'tokens', json: true });

    const parsed = JSON.parse(loggedOutput()) as {
      command: string;
      kind: string;
      items: Array<{ rank: number; providerKey: string; model: string; tokens: number }>;
    };
    expect(parsed.command).toBe('top');
    expect(parsed.kind).toBe('models');
    expect(parsed.items[0]).toMatchObject({
      rank: 1,
      providerKey: 'claude_code',
      model: 'opus',
      tokens: 1000,
    });
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
    });

    await topCommand({ kind: 'days', limit: 10, sort: 'tokens', year: 2026 });

    const out = loggedOutput();
    expect(out).toContain('2026-01-01');
    expect(out).not.toContain('2025-01-01');
  });

  it('respects an explicit --since/--until date range', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-03-10', makeDay(100, 0, 1, 'm1')],
          ['2026-06-20', makeDay(9999, 0, 99, 'm1')],
          ['2026-09-01', makeDay(5000, 0, 50, 'm1')],
        ]),
      },
      machineData: [],
    });

    await topCommand({
      kind: 'days',
      limit: 10,
      sort: 'tokens',
      since: '2026-04-01',
      until: '2026-08-01',
    });

    const out = loggedOutput();
    expect(out).toContain('2026-06-20');
    expect(out).toContain('(2026-04-01 → 2026-08-01)');
    expect(out).not.toContain('2026-03-10');
    expect(out).not.toContain('2026-09-01');
  });

  it('rejects a --since that falls after --until', async () => {
    await expect(
      topCommand({
        kind: 'days',
        limit: 10,
        sort: 'tokens',
        since: '2026-08-01',
        until: '2026-01-01',
      }),
    ).rejects.toThrow('must not be after');
  });

  it('echoes the date range into --json output', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: { claude_code: new Map([['2026-06-20', makeDay(100, 0, 1, 'm1')]]) },
      machineData: [],
    });

    await topCommand({
      kind: 'models',
      limit: 5,
      sort: 'cost',
      json: true,
      since: '2026-01-01',
      until: '2026-12-31',
    });

    const parsed = JSON.parse(loggedOutput()) as { since: string; until: string; year: null };
    expect(parsed).toMatchObject({ since: '2026-01-01', until: '2026-12-31', year: null });
  });

  it('days: ranks by tokens and prints JSON without a top provider when empty', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-01-01', makeDay(100, 0, undefined, 'm1')],
          ['2026-01-02', makeDay(200, 0, undefined, 'm1')],
        ]),
      },
      machineData: [],
    });

    await topCommand({ kind: 'days', limit: 5, sort: 'tokens', json: true, year: 2025 });

    const parsed = JSON.parse(loggedOutput()) as {
      command: string;
      kind: string;
      year: number;
      items: Array<{ topProvider: string | null }>;
    };
    expect(parsed.command).toBe('top');
    expect(parsed).toMatchObject({ kind: 'days', year: 2025, items: [] });
  });

  it('days: prints no-usage message when filtering removes all days', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([['2026-01-01', makeDay(100, 0, undefined, 'm1')]]),
      },
      machineData: [],
    });

    await topCommand({ kind: 'days', limit: 5, sort: 'tokens', year: 2025 });

    expect(loggedOutput()).toContain('No usage recorded.');
  });

  it('models: ranks by cost and prints no-usage when all rows are empty', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-01-01', makeDay(10, 0, 1, 'cheap')],
          ['2026-01-02', makeDay(1, 0, 10, 'expensive')],
        ]),
        codex: new Map([
          [
            '2026-01-01',
            {
              inputTokens: 0,
              outputTokens: 0,
              byModel: { empty: { inputTokens: 0, outputTokens: 0 } },
            },
          ],
        ]),
      },
      machineData: [],
    });

    await topCommand({ kind: 'models', limit: 5, sort: 'cost' });

    const out = loggedOutput();
    expect(out.indexOf('expensive')).toBeLessThan(out.indexOf('cheap'));

    vi.mocked(console.log).mockClear();
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        codex: new Map([
          [
            '2026-01-01',
            {
              inputTokens: 0,
              outputTokens: 0,
              byModel: { empty: { inputTokens: 0, outputTokens: 0 } },
            },
          ],
        ]),
      },
      machineData: [],
    });
    await topCommand({ kind: 'models', limit: 5, sort: 'cost' });

    expect(loggedOutput()).toContain('No usage recorded.');
  });

  it('emits empty message on no data', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);

    await topCommand({ kind: 'models', limit: 5, sort: 'cost' });

    expect(loggedOutput()).toContain('No data.');
  });

  it('emits valid empty JSON on no data', async () => {
    mocks.loadMergedProviderData.mockResolvedValue(null);

    await topCommand({ kind: 'models', limit: 5, sort: 'cost', json: true });

    expect(JSON.parse(loggedOutput())).toMatchObject({
      command: 'top',
      kind: 'models',
      sort: 'cost',
      limit: 5,
      items: [],
    });
  });
});
