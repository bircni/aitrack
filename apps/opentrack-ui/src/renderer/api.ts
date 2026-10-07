import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { AppState, OpentrackApi, Screen, SettingErrors, Settings } from '../shared/types.js';

interface Events {
  state: AppState;
  settings: Settings;
  screen: Screen;
  'setting-errors': SettingErrors;
  update: string;
}

function subscribe<K extends keyof Events>(
  event: K,
  listener: (payload: Events[K]) => void,
): () => void {
  // Caught here so a failed registration is no unhandled rejection even if never unsubscribed.
  const unlisten = listen<Events[K]>(event, ({ payload }) => {
    listener(payload);
  }).catch(() => undefined);
  return () => {
    void unlisten.then((stop) => stop?.());
  };
}

/** Commands are implemented in the Tauri shell (`apps/opentrack/src/commands.rs`). */
export const api: OpentrackApi = {
  getState: () => invoke('get_state'),
  refresh: () => invoke('refresh'),
  sync: () => invoke('sync'),
  getSettings: () => invoke('get_settings'),
  saveSettings: (settings) => invoke('save_settings', { settings }),
  openDashboard: (provider) => invoke('open_dashboard', { provider }),
  quit: () => invoke('quit'),
  fitHeight: (height) => {
    void invoke('fit_height', { height }).catch(() => undefined);
  },
  onState: (listener) => subscribe('state', listener),
  onSettings: (listener) => subscribe('settings', listener),
  onScreen: (listener) => subscribe('screen', listener),
  settingErrors: () => invoke('setting_errors'),
  onSettingErrors: (listener) => subscribe('setting-errors', listener),
  appVersion: () => invoke('app_version'),
  checkForUpdate: () => invoke('check_update'),
  availableUpdate: () => invoke('available_update'),
  onUpdate: (listener) => subscribe('update', listener),
  installUpdate: () => invoke('install_update'),
};
