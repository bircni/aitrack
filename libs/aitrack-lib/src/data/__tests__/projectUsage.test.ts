import { describe, expect, it } from 'vitest';

import { normalizeRemoteUrl } from '../project.js';
import { aggregateProjects, projectProviderData } from '../projectUsage.js';
import type { DayEntry, ProviderData } from '../types.js';

describe('normalizeRemoteUrl', () => {
  it.each([
    ['git@github.com:Owner/Repo.git', 'owner/repo'],
    ['git@github.com:owner/repo', 'owner/repo'],
    ['ssh://git@host.example:2222/owner/repo.git', 'owner/repo'],
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['https://user:s3cret@github.com/owner/repo/', 'owner/repo'],
    ['https://gitlab.example/group/sub/repo.git', 'sub/repo'],
    ['  git://host/owner/repo.git\n', 'owner/repo'],
  ])('keeps only owner/repo of %s', (url, expected) => {
    expect(normalizeRemoteUrl(url)).toBe(expected);
  });

  it.each([
    '',
    'repo',
    '/srv/git/repo.git',
    '../repo',
    'file:///srv/owner/repo.git',
    'C:\\work\\repo',
  ])('never keeps a local path or an unparseable value: %j', (url) => {
    expect(normalizeRemoteUrl(url)).toBeNull();
  });
});

function counts(entries: Record<string, [number, number]>) {
  return Object.fromEntries(
    Object.entries(entries).map(([key, [inputTokens, cost]]) => [
      key,
      { inputTokens, outputTokens: 0, costUSD: cost },
    ]),
  );
}

function day(
  tokens: number,
  costUSD: number,
  projects: Record<string, [number, number]>,
  cwds: Record<string, [number, number]> = {},
): DayEntry {
  return {
    inputTokens: tokens,
    outputTokens: 0,
    costUSD,
    byModel: { m: { inputTokens: tokens, outputTokens: 0, costUSD } },
    byProject: counts(projects),
    byCwd: counts(cwds),
  };
}

const DATA: ProviderData = {
  claude_code: new Map([
    [
      '2026-06-01',
      day(100, 10, { 'a/one': [60, 6], '(no remote)': [40, 4] }, { '/work/loose/sub': [40, 4] }),
    ],
    ['2026-06-02', day(50, 5, { 'a/one': [30, 3] })],
    ['2026-06-03', { inputTokens: 20, outputTokens: 0, costUSD: 2, byModel: {} }],
  ]),
  codex: new Map([['2026-06-01', day(10, 1, { 'b/two': [10, 1] })]]),
  cursor: new Map([['2026-06-01', { inputTokens: 999, outputTokens: 0, byModel: {} }]]),
};

describe('aggregateProjects', () => {
  it('sums projects and the unattributed remainder to the synced providers total', () => {
    const { projects, unattributed } = aggregateProjects(DATA);
    expect(projects.map((p) => [p.project, p.tokens, p.costUSD])).toEqual([
      ['a/one', 90, 9],
      ['(no remote)', 40, 4],
      ['b/two', 10, 1],
    ]);
    expect(unattributed).toMatchObject({
      project: '(unattributed)',
      unattributed: true,
      tokens: 40,
      costUSD: 4,
    });
    const all = [...projects, ...(unattributed ? [unattributed] : [])];
    expect(all.reduce((sum, p) => sum + p.tokens, 0)).toBe(100 + 50 + 20 + 10);
    expect(all.reduce((sum, p) => sum + p.costUSD, 0)).toBeCloseTo(10 + 5 + 2 + 1);
    expect(projects[0]?.providers.map((p) => p.key)).toEqual(['claude_code']);
  });

  it('honours the window and leaves a fully attributed day without a remainder', () => {
    const { projects, unattributed } = aggregateProjects(DATA, {
      start: '2026-06-01',
      end: '2026-06-01',
    });
    expect(projects.map((p) => p.project)).toEqual(['a/one', '(no remote)', 'b/two']);
    expect(unattributed).toBeUndefined();
  });
});

describe('projectProviderData', () => {
  it('reduces each day to the project as one model row and drops providers without it', () => {
    const scoped = projectProviderData(DATA, { kind: 'project', project: 'a/one' });
    expect(Object.keys(scoped)).toEqual(['claude_code']);
    expect([...(scoped.claude_code?.keys() ?? [])]).toEqual(['2026-06-01', '2026-06-02']);
    expect(scoped.claude_code?.get('2026-06-01')?.byModel).toEqual({
      '(all models)': { inputTokens: 60, outputTokens: 0, costUSD: 6 },
    });
  });

  it('matches a folder without a remote by working-directory prefix, not by a sibling', () => {
    const inside = projectProviderData(DATA, { kind: 'dir', dir: '/work/loose' });
    expect(inside.claude_code?.get('2026-06-01')?.inputTokens).toBe(40);
    expect(projectProviderData(DATA, { kind: 'dir', dir: '/work/lo' })).toEqual({});
  });
});
