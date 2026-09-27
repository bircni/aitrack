// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { LeverageScreen } from '../screens/Leverage';

const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>();

const report = {
  linkedCommits: 1,
  humanCommits: 1,
  confidence: 'low',
  comparisons: [],
  speed: [],
  quality: [],
  cost: [],
  ratings: { kept: 2, reworked: 1, discarded: 0, unrated: 4 },
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === 'repos:list') {
      return Promise.resolve([
        {
          id: 'repo',
          rootPath: '/repo',
          name: 'demo',
          remoteUrl: null,
          enabled: true,
          testGlobs: [],
          lastSeen: null,
          gitOk: true,
          gitDetail: null,
          importedAt: null,
        },
      ]);
    }
    if (channel === 'leverage:get') {
      return Promise.resolve({
        report,
        tabs: {
          id: 'tab-acceptance',
          label: 'Tab acceptance',
          value: null,
          unit: 'ratio',
          sampleSize: 0,
          confidence: 'low',
          rule: 'Accepted tab completions divided by suggestions Cursor recorded that day.',
          caveat: '',
          inputs: {},
        },
      });
    }
    return Promise.resolve({ ok: true, message: 'Saved' });
  });
  window.aitrack = { invoke, onChanged: () => () => undefined };
});

it('asks for a 90 day window and a custom range', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LeverageScreen />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'Linked, and on your own' });
  expect(screen.getByText('1 of 2 commits (50%) have a session behind them.')).toBeTruthy();
  expect(
    screen.getByText('2 kept, 1 reworked, 0 discarded, 4 unrated in this window.'),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Window'), { target: { value: '90' } });
  await waitFor(() => {
    const body = lastWindow();
    const from = Date.parse(String(body.from));
    const to = Date.parse(String(body.to));
    const days = (to - from) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  fireEvent.change(screen.getByLabelText('Window'), { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-20' } });
  await waitFor(() => {
    const body = lastWindow();
    expect(localDay(body.from)).toBe('2026-09-01');
    expect(localDay(body.to)).toBe('2026-09-20');
  });
});

function localDay(value: unknown): string {
  const date = new Date(String(value));
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

function lastWindow(): { from?: unknown; to?: unknown } {
  const calls = invoke.mock.calls.filter((call) => call[0] === 'leverage:get');
  const payload = calls.at(-1)?.[1];
  if (typeof payload !== 'object' || payload === null) return {};
  return payload;
}
