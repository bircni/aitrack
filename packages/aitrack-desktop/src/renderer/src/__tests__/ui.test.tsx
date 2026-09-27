// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Explain } from '../Explain';
import { CostScreen } from '../screens/Cost';
import { Onboarding } from '../screens/Onboarding';
import { SettingsScreen } from '../screens/Settings';

const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>();

function host(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === 'bootstrap') {
      return Promise.resolve({
        platform: 'darwin',
        onboarded: true,
        theme: 'dark',
        claude: true,
        codex: true,
        cursor: true,
        paused: false,
        background: true,
        openAtLogin: false,
        rateReminder: false,
      });
    }
    if (channel === 'sync:status') {
      return Promise.resolve({
        configured: false,
        cloned: false,
        machineId: null,
        repoUrl: null,
        dirty: false,
      });
    }
    if (channel === 'sources:get') {
      return Promise.resolve({
        claude: ['/claude'],
        codex: ['/codex'],
        linkBeforeMin: 5,
        linkAfterHours: 6,
      });
    }
    if (channel === 'diagnostics:get') {
      return Promise.resolve({
        checks: [{ status: 'ok', label: 'git', detail: 'Available on PATH' }],
        log: [{ at: '2026-09-27T00:00:00.000Z', kind: 'ingest', detail: '1 sessions' }],
      });
    }
    if (channel === 'cost:get') return Promise.resolve([]);
    if (channel === 'cost:models') return Promise.resolve([]);
    if (channel === 'cost:budget') return Promise.resolve({ monthlyUSD: null, status: null });
    if (channel === 'settings:update') return Promise.resolve({ ok: true, message: 'Saved' });
    if (channel === 'sync:connect') {
      return Promise.resolve({ ok: true, message: 'Connected the data repo.' });
    }
    return Promise.resolve({ ok: true, message: 'Saved' });
  });
  window.aitrack = {
    invoke,
    onChanged: () => () => undefined,
  };
});

it('reveals the rule behind a figure', () => {
  host(<Explain figure="$1.00" rule="Sum of stored day totals." />);
  expect(screen.queryByText('Sum of stored day totals.')).toBeNull();
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('Sum of stored day totals.')).toBeTruthy();
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
});

it('starts watching without cloning when the data repo is left blank', async () => {
  host(<Onboarding />);
  fireEvent.click(screen.getByRole('button', { name: 'Start watching' }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith('settings:update', {
      onboarded: true,
      claude: true,
      codex: true,
      cursor: true,
    });
  });
  const channels = invoke.mock.calls.map((call) => call[0]);
  expect(channels).not.toContain('sync:connect');
});

it('connects a data repo from settings when the URL is filled in', async () => {
  host(<SettingsScreen />);
  await screen.findByRole('button', { name: 'Connect this repo' });
  fireEvent.change(screen.getByLabelText('Data repo URL'), {
    target: { value: 'git@example.com:me/data.git' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect this repo' }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith('sync:connect', {
      confirm: 'clone',
      repoUrl: 'git@example.com:me/data.git',
    });
  });
  expect(await screen.findByText('Connected the data repo.')).toBeTruthy();
});

it('explains the last 30 days against the previous 30', async () => {
  host(<CostScreen />);
  fireEvent.click(await screen.findByRole('button', { name: /Last 30 days/u }));
  expect(screen.getByText(/falls in the last 30 days/u)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Window'), { target: { value: '7' } });
  expect(screen.getByRole('button', { name: /Last 7 days/u })).toBeTruthy();
  expect(screen.getByText(/falls in the last 7 days/u)).toBeTruthy();
  expect(screen.getByRole('button', { name: /Previous 7 days/u })).toBeTruthy();
});

it('shows a doctor check next to the ingest log', async () => {
  host(<SettingsScreen />);
  expect(await screen.findByText('Available on PATH')).toBeTruthy();
  expect(screen.getByText('ingest: 1 sessions')).toBeTruthy();
});
