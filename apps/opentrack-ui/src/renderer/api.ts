import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { AppState, OpentrackApi, Screen, SettingErrors, Settings } from '../shared/types.js';

/** The shell's view of the background service; it is not part of the state the service itself pushes. */
export interface ServiceStatus {
  state: 'starting' | 'running' | 'down';
  /** Set only while down: the reason, including the log path. */
  message: string | null;
}

interface DesktopApi extends Omit<OpentrackApi, 'onUpdate'> {
  /** Null when an offered release was withdrawn. */
  onUpdate: (listener: (version: string | null) => void) => () => void;
  /** Asked for on mount, since the event may have fired before the page loaded. */
  serviceStatus: () => Promise<ServiceStatus>;
  onServiceStatus: (listener: (status: ServiceStatus) => void) => () => void;
  hideWindow: () => void;
}

interface Events {
  state: AppState;
  settings: Settings;
  screen: Screen;
  'setting-errors': SettingErrors;
  update: string | null;
  'service-status': ServiceStatus;
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
export const api: DesktopApi = {
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
  hideWindow: () => {
    void invoke('hide_window').catch(() => undefined);
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
  serviceStatus: () => invoke('service_status'),
  onServiceStatus: (listener) => subscribe('service-status', listener),
};
