import { setTimeout as flush } from 'node:timers/promises';

import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  // A promise the spy does not track, since tracking would mark a rejection as handled.
  listen: (...args: unknown[]) => (mocks.listen(...args) as Promise<unknown>).then((stop) => stop),
}));
import { DEFAULT_SETTINGS } from '../../sidecar/settings.js';
import { api } from '../api.js';

afterEach(() => {
  vi.resetAllMocks();
});

it('delivers every shell command and preserves operation arguments and delivery errors', async () => {
  await api.getState();
  await api.getSettings();
  await api.saveSettings(DEFAULT_SETTINGS);
  await api.openDashboard('cursor');
  await api.quit();
  await api.settingErrors();
  expect(mocks.invoke).toHaveBeenCalledWith('setting_errors');
  await api.appVersion();
  await api.checkForUpdate();
  expect(mocks.invoke).toHaveBeenCalledWith('check_update');
  await api.availableUpdate();
  await api.installUpdate();
  expect(mocks.invoke).toHaveBeenCalledWith('install_update');
  expect(mocks.invoke).toHaveBeenCalledWith('save_settings', { settings: DEFAULT_SETTINGS });
  expect(mocks.invoke).toHaveBeenCalledWith('open_dashboard', { provider: 'cursor' });
  mocks.invoke.mockRejectedValue(new Error('disconnected'));
  await expect(api.refresh()).rejects.toThrow('disconnected');
  await expect(api.sync()).rejects.toThrow('disconnected');
  api.fitHeight(100);
  await Promise.resolve();
  expect(mocks.invoke).toHaveBeenCalledWith('fit_height', { height: 100 });
});

it('delivers event payloads and releases asynchronous subscriptions safely', async () => {
  const stop = vi.fn();
  mocks.listen.mockResolvedValue(stop);
  const callback = vi.fn<(payload: unknown) => void>();
  const releases = [
    api.onState(callback),
    api.onSettings(callback),
    api.onScreen(callback),
    api.onSettingErrors(callback),
    api.onUpdate(callback),
  ];
  for (const call of mocks.listen.mock.calls) {
    const handler = call[1] as (event: { payload: unknown }) => void;
    handler({ payload: 'payload' });
  }
  expect(callback).toHaveBeenCalledTimes(5);
  expect(mocks.listen).toHaveBeenCalledWith('setting-errors', expect.any(Function));
  for (const release of releases) release();
  await flush();
  expect(stop).toHaveBeenCalledTimes(5);
  mocks.listen.mockRejectedValue(new Error('closed'));
  const release = api.onScreen(callback);
  await flush(); // Lets an unhandled rejection surface.
  release();
  await flush();
});
