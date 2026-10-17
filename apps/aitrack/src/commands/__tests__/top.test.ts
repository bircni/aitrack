import { makeDay, loggedOutput } from '@aitrack/test-fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadMergedProviderData: vi.fn(),
  tryLoadConfig: vi.fn(),
  isCloned: vi.fn(),
}));

vi.mock('aitrack-lib/data/usageData', () => ({
  loadMergedProviderData: mocks.loadMergedProviderData,
  usageEmptyMessage: () => 'No data.',
  usageEmptyWindowMessage: () => 'No usage recorded.',
}));
vi.mock('aitrack-lib/config', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('aitrack-lib/git', () => ({ isCloned: mocks.isCloned }));

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
    const opusIndex = out.indexOf('Opus');
    const sonnetIndex = out.indexOf('Sonnet');
    expect(opusIndex).toBeGreaterThan(-1);
    expect(sonnetIndex).toBeGreaterThan(opusIndex);
  });

  it('names unpriced models in the footnote and in JSON', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        cursor: new Map([
          [
            '2026-01-01',
            {
              inputTokens: 5,
              outputTokens: 5,
              byModel: { mystery: { inputTokens: 5, outputTokens: 5 } },
            },
          ],
        ]),
      },
      machineData: [],
    });

    await topCommand({ kind: 'days', limit: 5, sort: 'tokens' });
    expect(loggedOutput()).toContain('Unpriced models: mystery');

    vi.mocked(console.log).mockClear();
    await topCommand({ kind: 'models', limit: 5, sort: 'tokens', json: true });
    expect((JSON.parse(loggedOutput()) as { unpricedModels: string[] }).unpricedModels).toEqual([
      'mystery',
    ]);
  });

  it('projects: ranks by tokens, keeps the unattributed remainder and says Cursor is excluded', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          [
            '2026-01-01',
            {
              ...makeDay(100, 0, 10, 'opus'),
              byProject: { 'acme/widget': { inputTokens: 60, outputTokens: 0, costUSD: 6 } },
            },
          ],
        ]),
      },
      machineData: [],
    });

    await topCommand({ kind: 'projects', limit: 5, sort: 'tokens' });
    const out = loggedOutput();
    expect(out).toContain('Top 5 projects by tokens');
    expect(out.indexOf('acme/widget')).toBeLessThan(out.indexOf('(unattributed)'));
    expect(out).toContain('Cursor usage is not attributed');

    vi.mocked(console.log).mockClear();
    await topCommand({ kind: 'projects', limit: 5, sort: 'cost', json: true });
    const parsed = JSON.parse(loggedOutput()) as {
      items: Array<{ project: string; unattributed: boolean; tokens: number }>;
      notes: string[];
    };
    expect(parsed.items.map((item) => [item.project, item.unattributed, item.tokens])).toEqual([
      ['acme/widget', false, 60],
      ['(unattributed)', true, 40],
    ]);
    expect(parsed.notes).toHaveLength(1);
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

  it('names both filters in the title when --year and --since are combined', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-01-01', makeDay(100, 0, 1, 'm1')],
          ['2025-06-01', makeDay(9999, 0, 99, 'm1')],
        ]),
      },
      machineData: [],
    });

    await topCommand({ kind: 'days', limit: 10, sort: 'tokens', year: 2026, since: '2025-01-01' });

    const out = loggedOutput();
    expect(out).toContain('Top 10 days by tokens (2026, 2025-01-01 → …)');
    expect(out).not.toContain('2025-06-01');
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

  it('days: ranks by tokens in --json output', async () => {
    mocks.loadMergedProviderData.mockResolvedValue({
      providerData: {
        claude_code: new Map([
          ['2026-01-01', makeDay(100, 0, undefined, 'm1')],
          ['2026-01-02', makeDay(200, 0, undefined, 'm1')],
        ]),
      },
      machineData: [],
    });

    await topCommand({ kind: 'days', limit: 5, sort: 'tokens', json: true, year: 2026 });

    expect(JSON.parse(loggedOutput())).toMatchObject({
      command: 'top',
      kind: 'days',
      year: 2026,
      items: [
        { rank: 1, date: '2026-01-02', tokens: 200, topProvider: 'claude_code' },
        { rank: 2, date: '2026-01-01', tokens: 100 },
      ],
    });
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

  it.each([
    [false, ['No data.']],
    [true, ['"command": "top"', '"items": []', '"message": "No data."']],
  ])('reports no data (json: %s)', async (json, expected) => {
    mocks.loadMergedProviderData.mockResolvedValue(null);

    await topCommand({ kind: 'models', limit: 5, sort: 'cost', json });

    for (const part of expected) expect(loggedOutput()).toContain(part);
  });
});
