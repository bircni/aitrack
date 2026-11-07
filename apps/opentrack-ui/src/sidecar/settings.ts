import { readFile } from 'node:fs/promises';

import { writeFileAtomic } from 'aitrack-lib/atomicWrite';
import { isRecord } from 'aitrack-lib/data/guards';
import { isProviderKey, type ProviderKey, providerKeys } from 'aitrack-lib/providers/descriptors';
import { providerLabel } from 'aitrack-lib/providers/registry';
import { QUOTA_PROVIDERS } from 'aitrack-lib/quota/index';

import type { Settings } from '../shared/types.js';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  display: 'used',
  resetDisplay: 'absolute',
  providers: providerKeys().map((key) => ({ key, label: providerLabel(key), enabled: true })),
  launchAtLogin: false,
  globalShortcut: '',
  notifications: true,
  windowMode: 'popup',
  pullSyncedData: true,
  trayProvider: 'auto',
  trayWindow: 'highest',
  trayStyle: 'icon',
  trayColored: true,
};

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Settings from untrusted input (disk or the renderer): unknown fields are
 * dropped, bad values fall back, and every provider appears exactly once.
 */
export function normalizeSettings(input: unknown): Settings {
  const raw = isRecord(input) ? input : {};
  const seen = new Set<ProviderKey>();
  const providers: Settings['providers'] = [];
  for (const entry of Array.isArray(raw.providers) ? raw.providers : []) {
    if (!isRecord(entry)) continue;
    const { key, enabled } = entry;
    if (!isProviderKey(key) || seen.has(key)) continue;
    seen.add(key);
    providers.push({ key, label: providerLabel(key), enabled: bool(enabled, true) });
  }
  for (const key of providerKeys()) {
    if (!seen.has(key)) providers.push({ key, label: providerLabel(key), enabled: true });
  }
  const d = DEFAULT_SETTINGS;
  return {
    theme: pick(raw.theme, ['system', 'light', 'dark'], d.theme),
    display: pick(raw.display, ['used', 'left'], d.display),
    resetDisplay: pick(raw.resetDisplay, ['relative', 'absolute'], d.resetDisplay),
    providers,
    launchAtLogin: bool(raw.launchAtLogin, d.launchAtLogin),
    globalShortcut: typeof raw.globalShortcut === 'string' ? raw.globalShortcut.trim() : '',
    notifications: bool(raw.notifications, d.notifications),
    windowMode: pick(raw.windowMode, ['popup', 'floating'], d.windowMode),
    pullSyncedData: bool(raw.pullSyncedData, d.pullSyncedData),
    trayProvider: pick(raw.trayProvider, ['auto', ...QUOTA_PROVIDERS], d.trayProvider),
    trayWindow: pick(raw.trayWindow, ['highest', 'session', 'weekly'], d.trayWindow),
    trayStyle: pick(raw.trayStyle, ['icon', 'bars'], d.trayStyle),
    trayColored: bool(raw.trayColored, d.trayColored),
  };
}

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function loadSettings(path: string): Promise<Settings> {
  return normalizeSettings(await readJsonFile(path));
}
