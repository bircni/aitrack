import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toLocalDateString } from 'aitrack-lib/data/dayMap';
import type { DayEntry } from 'aitrack-lib/data/types';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderState, QuotaSnapshot } from '../../shared/types.js';
import { dueAlerts, pruneFired } from '../alerts.js';
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, writeJsonFile } from '../settings.js';
import { renderTrayIcon, summarizeTray } from '../trayIcon.js';
import { summarizeUsage } from '../usage.js';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const HOUR = 3_600_000;

function snapshot(windows: QuotaSnapshot['windows']): QuotaSnapshot {
  return { provider: 'claude_code', windows, values: [], fetchedAt: new Date(NOW).toISOString() };
}

function sessionWindow(usedPercent: number, elapsedHours: number) {
  return {
    id: 'session',
    label: 'Session',
    usedPercent,
    periodSeconds: 5 * 3600,
    resetsAt: new Date(NOW + (5 - elapsedHours) * HOUR).toISOString(),
    format: 'percent' as const,
  };
}

function provider(windows: QuotaSnapshot['windows']): ProviderState {
  return {
    key: 'claude_code',
    label: 'Claude Code',
    quota: snapshot(windows),
    refreshing: false,
  };
}

function day(input: number, output: number, costUSD: number): DayEntry {
  return {
    inputTokens: input,
    outputTokens: output,
    costUSD,
    byModel: { 'claude-sonnet-4-6': { inputTokens: input, outputTokens: output, costUSD } },
  };
}

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
    });
    expect(settings.theme).toBe('system');
    expect(settings.display).toBe('left');
    expect(settings.globalShortcut).toBe('Alt+U');
    expect(settings.notifications).toBe(true);
    expect(settings.providers).toEqual([
      { key: 'cursor', label: 'Cursor', enabled: false },
      { key: 'claude_code', label: 'Claude Code', enabled: true },
      { key: 'codex', label: 'Codex', enabled: true },
    ]);
  });

  it('round-trips through disk and tolerates a corrupt file', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'opentrack-'));
    const path = join(tmpDir, 'nested', 'settings.json');
    await writeJsonFile(path, { ...DEFAULT_SETTINGS, theme: 'dark' });
    const written: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(written).toMatchObject({ theme: 'dark' });
    const loaded = await loadSettings(path);
    expect(loaded.theme).toBe('dark');
    writeFileSync(path, '{');
    expect(await loadSettings(path)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('alerts', () => {
  it('fires almost-out once per reset', () => {
    const quota = snapshot([sessionWindow(95, 2)]);
    const alerts = dueAlerts('Claude Code', quota, {}, NOW);
    expect(alerts).toMatchObject([
      { title: 'Claude Code session almost used up', body: '5% left until it resets.' },
    ]);
    const fired = Object.fromEntries(alerts.map((alert) => [alert.key, alert.resetsAt]));
    expect(dueAlerts('Claude Code', quota, fired, NOW)).toEqual([]);
    const drifted = {
      ...sessionWindow(95, 2),
      resetsAt: new Date(NOW + 3 * HOUR + 1000).toISOString(),
    };
    expect(dueAlerts('Claude Code', snapshot([drifted]), fired, NOW)).toEqual([]);
  });

  it('fires will-run-out from the pace and skips windows it cannot judge', () => {
    const alerts = dueAlerts(
      'Codex',
      snapshot([
        sessionWindow(80, 2.5),
        sessionWindow(10, 2.5),
        { ...sessionWindow(50, 1), resetsAt: undefined },
        { ...sessionWindow(99, 1), format: 'dollars' },
      ]),
      {},
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.title).toBe('Codex session on pace to run out');
  });

  it('prunes alerts for windows that have reset', () => {
    expect(
      pruneFired(
        {
          old: new Date(NOW - 5 * 60_000 - 1).toISOString(),
          grace: new Date(NOW - 1).toISOString(),
        },
        NOW,
      ),
    ).toEqual({ grace: new Date(NOW - 1).toISOString() });
  });
});

describe('tray icon', () => {
  const AUTO = { trayProvider: 'auto', trayWindow: 'highest' } as const;

  it('takes the most urgent tone and the highest usage', () => {
    const summary = summarizeTray(
      [
        provider([sessionWindow(20, 2.5)]),
        provider([sessionWindow(48, 2.5)]),
        { ...provider([]), quota: undefined },
      ],
      NOW,
      AUTO,
    );
    expect(summary).toEqual({
      tone: 'warn',
      usedPercent: 48,
      tooltip: 'opentrack\nClaude Code: 20% session\nClaude Code: 48% session',
    });
    expect(summarizeTray([], NOW, AUTO).tone).toBe('neutral');
    // No reset time means no pace, so fullness alone decides, as on the meter.
    const unpaced = { ...sessionWindow(95, 2.5), resetsAt: undefined };
    expect(summarizeTray([provider([unpaced])], NOW, AUTO).tone).toBe('crit');
  });

  it('follows the chosen provider and window', () => {
    const weekly = { ...sessionWindow(10, 2.5), id: 'weekly', label: 'Weekly' };
    const codex = { ...provider([sessionWindow(90, 2.5), weekly]), key: 'codex' as const };
    const providers = [provider([sessionWindow(60, 2.5)]), codex];
    expect(
      summarizeTray(providers, NOW, { trayProvider: 'codex', trayWindow: 'weekly' }),
    ).toMatchObject({ usedPercent: 10, tone: 'calm' });
    // Claude has no weekly window, so it falls back to its most used one.
    expect(
      summarizeTray(providers, NOW, { trayProvider: 'claude_code', trayWindow: 'weekly' }),
    ).toMatchObject({ usedPercent: 60 });
    expect(
      summarizeTray([codex], NOW, { trayProvider: 'claude_code', trayWindow: 'session' }),
    ).toMatchObject({ usedPercent: 90 });
  });

  it('draws the outline ring, the used wedge solid and the rest faint', () => {
    const size = 32;
    const pixels = renderTrayIcon(size, 25, 'crit');
    expect(pixels).toHaveLength(size * size * 4);
    const alphaAt = (x: number, y: number) => pixels[(y * size + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(0); // Corner, outside the O
    expect(alphaAt(16, 1)).toBe(255); // Outline ring
    expect(alphaAt(16, 5)).toBe(0); // Gap between ring and pie
    expect(alphaAt(19, 10)).toBe(255); // Just clockwise of 12 o'clock: used
    expect(alphaAt(16, 16)).toBe(71); // Past the wedge: left, faint
  });
});

describe('summarizeUsage', () => {
  it('builds today, yesterday, 30 days and the daily series', () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const summary = summarizeUsage(
      {
        providerData: {
          claude_code: new Map([
            [toLocalDateString(now), day(100, 50, 1.5)],
            [toLocalDateString(yesterday), day(10, 5, 0.25)],
          ]),
        },
        machineData: [],
      },
      now,
    );
    const claude = summary.providers.claude_code;
    if (!claude) throw new Error('expected Claude Code usage');
    expect(claude.today).toMatchObject({ tokens: 150, costUSD: 1.5, hasCost: true });
    expect(claude.today.models).toEqual([
      { model: 'claude-sonnet-4-6', tokens: 150, costUSD: 1.5, hasCost: true },
    ]);
    expect(claude.yesterday.tokens).toBe(15);
    expect(claude.last7Days.tokens).toBe(165);
    expect(claude.last30Days.tokens).toBe(165);
    expect(claude.daily).toHaveLength(30);
    expect(claude.daily.at(-1)).toEqual({
      date: toLocalDateString(now),
      costUSD: 1.5,
    });
    expect(summary.providers.codex).toBeUndefined();
    expect(summary.machineCount).toBe(1);
    expect(summarizeUsage(null)).toEqual({ providers: {}, machineCount: 1 });
  });

  it('gives an empty period for a provider with nothing in the window', () => {
    const old = new Date();
    old.setDate(old.getDate() - 3);
    const summary = summarizeUsage({
      providerData: { codex: new Map([[toLocalDateString(old), day(1, 1, 0)]]) },
      machineData: [],
    });
    expect(summary.providers.codex?.today).toEqual({
      tokens: 0,
      costUSD: 0,
      hasCost: false,
      models: [],
    });
  });
});
