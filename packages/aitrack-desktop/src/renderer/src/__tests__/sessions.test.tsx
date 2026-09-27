// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SessionsScreen } from '../screens/Sessions';

const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>();

const summary = {
  id: 's1',
  provider: 'claude',
  title: 'app.ts',
  cwd: '/repo',
  branch: 'main',
  startedAt: '2026-09-20T12:00:00.000Z',
  endedAt: '2026-09-20T12:04:00.000Z',
  costUsd: 0.01,
  inputTokens: 100,
  outputTokens: 50,
  tokensKnown: true,
  rating: null,
  linkedCommits: 1,
  repoId: 'repo',
  toolCalls: 1,
  userMessages: 1,
  assistantMessages: 1,
};

const detail = {
  ...summary,
  ratingNote: null,
  branches: ['main'],
  turns: [],
  files: [],
  links: [],
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === 'sessions:list') return Promise.resolve([summary]);
    if (channel === 'sessions:get') return Promise.resolve(detail);
    return Promise.resolve({ ok: true, message: 'Saved' });
  });
  window.aitrack = { invoke, onChanged: () => () => undefined };
});

it('sends the optional note with the rating', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionsScreen />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Kept' });
  fireEvent.change(screen.getByLabelText('Rating note'), {
    target: { value: '  shipped the fix  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Reworked' }));
  await waitFor(() => {
    const call = invoke.mock.calls.find((entry) => entry[0] === 'sessions:rate');
    expect(call?.[1]).toEqual({ id: 's1', rating: 'reworked', note: 'shipped the fix' });
  });
});
