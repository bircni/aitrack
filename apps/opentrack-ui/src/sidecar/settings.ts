import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isRecord } from 'aitrack-lib/data/guards';
import { providerLabel } from 'aitrack-lib/providers/registry';
import { QUOTA_PROVIDERS } from 'aitrack-lib/quota/index';

import type { QuotaProviderKey, Settings } from '../shared/types.js';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  display: 'used',
  resetDisplay: 'absolute',
  providers: QUOTA_PROVIDERS.map((key) => ({ key, label: providerLabel(key), enabled: true })),
  launchAtLogin: false,
  globalShortcut: '',
  notifications: true,
  windowMode: 'popup',
  pullSyncedData: true,
  trayProvider: 'auto',
  trayWindow: 'highest',
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
  const seen = new Set<QuotaProviderKey>();
  const providers: Settings['providers'] = [];
  for (const entry of Array.isArray(raw.providers) ? raw.providers : []) {
    if (!isRecord(entry)) continue;
    const { key, enabled } = entry;
    if (!QUOTA_PROVIDERS.includes(key as QuotaProviderKey)) continue;
    const provider = key as QuotaProviderKey;
    if (seen.has(provider)) continue;
    seen.add(provider);
    providers.push({ key: provider, label: providerLabel(provider), enabled: bool(enabled, true) });
  }
  for (const key of QUOTA_PROVIDERS) {
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
  };
}

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const pendingWrites = new Map<string, Promise<void>>();

/**
 * Write-then-rename so a crash mid-write never leaves a truncated file, queued
 * per path so overlapping writes share the temp file safely and the last call wins.
 */
export function writeJsonFile(path: string, value: unknown): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`; // Now, before the caller mutates it.
  const write = async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${String(process.pid)}.tmp`;
    await writeFile(temporary, contents);
    await rename(temporary, path);
  };
  const next = (pendingWrites.get(path) ?? Promise.resolve()).then(write, write);
  pendingWrites.set(path, next);
  return next;
}

export async function loadSettings(path: string): Promise<Settings> {
  return normalizeSettings(await readJsonFile(path));
}
