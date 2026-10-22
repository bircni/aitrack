import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, writeJsonFile } from '../settings.js';

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('settings', () => {
  it('fills defaults and drops bad values', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    const settings = normalizeSettings({
      theme: 'neon',
      display: 'left',
      providers: [{ key: 'cursor', enabled: false }, { key: 'cursor' }, { key: 'bogus' }, null],
      globalShortcut: '  Alt+U ',
      notifications: 'yes',
      trayStyle: 'square',
      trayColored: 'yes',
    });
    expect(settings.theme).toBe('system');
    expect(settings.display).toBe('left');
    expect(settings.globalShortcut).toBe('Alt+U');
    expect(settings.notifications).toBe(true);
    expect(settings.trayStyle).toBe('icon');
    expect(settings.trayColored).toBe(true);
    expect(settings.providers).toEqual([
      { key: 'cursor', label: 'Cursor', enabled: false },
      { key: 'claude_code', label: 'Claude Code', enabled: true },
      { key: 'codex', label: 'Codex', enabled: true },
      { key: 'vibe', label: 'Mistral Vibe', enabled: true },
    ]);
  });

  it('round-trips through disk and tolerates a corrupt file', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'opentrack-'));
    const path = join(tmpDir, 'nested', 'settings.json');
    await writeJsonFile(path, {
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      trayStyle: 'bars',
      trayColored: false,
    });
    const written: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(written).toMatchObject({ theme: 'dark' });
    const loaded = await loadSettings(path);
    expect(loaded.theme).toBe('dark');
    expect(loaded.trayStyle).toBe('bars');
    expect(loaded.trayColored).toBe(false);
    writeFileSync(path, '{');
    expect(await loadSettings(path)).toEqual(DEFAULT_SETTINGS);
  });
});
