import { makeDay } from '@aitrack/test-fixtures';
import { expect, it } from 'vitest';

import { compareByCostThenTokens, costValue } from '../sort.js';
import { topDays, topModels, topProjects, topProviderKey, unpricedTopModels } from '../topUsage.js';
import type { ProviderData } from '../types.js';

it('ranks priced and unpriced days and models, combines providers and applies date filters', () => {
  const data: ProviderData = {
    claude_code: new Map([
      ['2026-01-01', makeDay(10, 2, 1)],
      ['2026-01-02', makeDay(30, 0)],
    ]),
    codex: new Map([
      ['2026-01-01', makeDay(10, 2, 2)],
      ['2025-01-01', makeDay(1, 0, 10)],
    ]),
  };
  expect(topDays(data, 1, 'tokens')[0]).toMatchObject({
    date: '2026-01-02',
    tokens: 30,
    cost: null,
  });
  expect(topDays(data, 1, 'cost')[0]?.date).toBe('2025-01-01');
  expect(topDays(data, 5, 'cost', { year: 2026 })[0]).toMatchObject({
    date: '2026-01-01',
    cost: 3,
    tokens: 24,
  });
  expect(topModels(data, 5, 'tokens', { start: '2026-01-01' })[0]?.providerKey).toBe('claude_code');
  expect(topModels(data, 1, 'cost')[0]?.providerKey).toBe('codex');
  expect(topProviderKey({ claude_code: 1, codex: 2 })).toBe('codex');
  expect(topProviderKey({})).toBeNull();
  expect(costValue({ tokens: 0 })).toBe(0);
  expect(costValue({ tokens: 0, cost: null })).toBe(0);
  expect(compareByCostThenTokens({ tokens: 1, cost: 1 }, { tokens: 2, costUSD: 1 })).toBe(1);
  expect(
    topDays(
      {
        claude_code: new Map([
          ['2026-01-01', makeDay(1, 0)],
          ['2026-01-02', makeDay(1, 0)],
        ]),
      },
      5,
      'tokens',
    ),
  ).toHaveLength(2);
});

it('ranks projects with the unattributed remainder among them', () => {
  const data: ProviderData = {
    claude_code: new Map([
      [
        '2026-01-01',
        {
          ...makeDay(100, 0, 10),
          byProject: { 'a/one': { inputTokens: 30, outputTokens: 0, costUSD: 3 } },
        },
      ],
    ]),
  };
  expect(topProjects(data, 5, 'cost').map((p) => [p.project, p.tokens, p.cost])).toEqual([
    ['(unattributed)', 70, 7],
    ['a/one', 30, 3],
  ]);
  expect(topProjects(data, 1, 'tokens')[0]).toMatchObject({
    unattributed: true,
    byProvider: { claude_code: 70 },
  });
});

it('lists the unpriced models of days and of model rows once, sorted', () => {
  const day = {
    date: '2026-01-01',
    byProvider: {},
    tokens: 1,
    cost: 0,
    unpricedModels: ['b', 'a'],
  };
  const model = {
    providerKey: 'codex',
    provider: 'Codex',
    model: 'c',
    days: 1,
    tokens: 1,
    cost: null,
    hasUnpricedTokens: true,
  };
  const priced = { ...model, model: 'd', hasUnpricedTokens: false };
  expect(unpricedTopModels([day, model, priced, { ...day, unpricedModels: ['a'] }])).toEqual([
    'a',
    'b',
    'c',
  ]);
});
