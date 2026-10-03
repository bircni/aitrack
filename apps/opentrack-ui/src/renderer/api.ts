import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { AppState, OpentrackApi, Screen, Settings } from '../shared/types.js';

interface Events {
  state: AppState;
  settings: Settings;
  screen: Screen;
  'shortcut-error': string | null;
}

function subscribe<K extends keyof Events>(
  event: K,
  listener: (payload: Events[K]) => void,
): () => void {
  const unlisten = listen<Events[K]>(event, ({ payload }) => {
    listener(payload);
  });
  return () => {
    void unlisten.then((stop) => {
      stop();
    });
  };
}

/** Commands are implemented in the Tauri shell (`apps/opentrack/src/commands.rs`). */
export const api: OpentrackApi = {
  getState: () => invoke('get_state'),
  refresh: () =>
    invoke('refresh').then(
      () => undefined,
      () => undefined,
    ),
  sync: () =>
    invoke('sync').then(
      () => undefined,
      () => undefined,
    ),
  getSettings: () => invoke('get_settings'),
  saveSettings: (settings) => invoke('save_settings', { settings }),
  openDashboard: (provider) => invoke('open_dashboard', { provider }),
  quit: () => invoke('quit'),
  fitHeight: (height) => {
    void invoke('fit_height', { height });
  },
  onState: (listener) => subscribe('state', listener),
  onSettings: (listener) => subscribe('settings', listener),
  onScreen: (listener) => subscribe('screen', listener),
  shortcutError: () => invoke('shortcut_error'),
  onShortcutError: (listener) => subscribe('shortcut-error', listener),
};
