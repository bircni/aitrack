import type { Settings } from '../../shared/types.js';

/** What the shell sends before anything is saved. */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  display: 'used',
  resetDisplay: 'absolute',
  providers: [
    { key: 'claude_code', label: 'Claude Code', enabled: true },
    { key: 'codex', label: 'Codex', enabled: true },
    { key: 'cursor', label: 'Cursor', enabled: true },
  ],
  launchAtLogin: false,
  globalShortcut: '',
  notifications: true,
  keepOpen: false,
  compact: false,
  pullSyncedData: true,
  trayProvider: 'auto',
  trayWindow: 'highest',
  trayStyle: 'icon',
  trayColored: true,
};
