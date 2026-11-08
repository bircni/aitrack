// Regenerate with `TSX_TSCONFIG_PATH=apps/opentrack-ui/tsconfig.json node --import tsx apps/opentrack/tests/fixtures/generate.ts`
// from a checkout that still has 4.x's sidecar (`git checkout 28b9e3c -- apps/opentrack-ui/src`).
// Records the sidecar's tray pixels, settings normalization and cache.json normalization.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sidecar = join(here, '../../../opentrack-ui/src/sidecar');
const { renderTrayIcon } = await import(join(sidecar, 'trayIcon.ts'));
const { normalizeSettings } = await import(join(sidecar, 'settings.ts'));
const { loadCachedState } = await import(join(sidecar, 'service.ts'));

const tones = ['neutral', 'calm', 'warn', 'crit'];
const tray = [];
for (const size of [16, 22, 32]) {
  for (const used of [0, 0.4, 12.5, 25, 49.99, 50, 73.3, 99.6, 100, 140, -5]) {
    for (const colored of [true, false]) {
      const tone = tones[tray.length % tones.length];
      tray.push({ size, used, tone, style: 'icon', colored, bars: [] });
    }
  }
  for (const count of [0, 1, 2, 3, 4, 6, 9]) {
    for (const colored of [true, false]) {
      const bars = Array.from({ length: count }, (_, index) => ({
        usedPercent: [0, 7.5, 33.3, 50, 66.6, 99.9, 100, 120, -1][index],
        tone: tones[index % tones.length],
      }));
      tray.push({ size, used: 50, tone: 'calm', style: 'bars', colored, bars });
    }
  }
}
const trayCases = tray.map((entry) => {
  const pixels = renderTrayIcon(entry.size, entry.used, entry.tone, {
    style: entry.style,
    colored: entry.colored,
    bars: entry.bars,
  });
  return { ...entry, sha256: createHash('sha256').update(pixels).digest('hex') };
});

const settingsInputs = [
  null,
  'garbage',
  [],
  {},
  { theme: 'dark', display: 'left', resetDisplay: 'relative', launchAtLogin: true, compact: true },
  { theme: 'neon', display: 1, resetDisplay: null, notifications: 'yes', pullSyncedData: 0 },
  { providers: [{ key: 'cursor', enabled: false }, { key: 'codex' }, { key: 'cursor' }, { key: 'bogus' }, null, 3] },
  { providers: { key: 'codex' } },
  { providers: [{ key: 'codex', enabled: 'no', label: 'Mine' }] },
  { globalShortcut: '  Alt+U ' },
  { globalShortcut: '  Ctrl+K﻿\n' },
  { globalShortcut: 42 },
  { windowMode: 'floating' },
  { windowMode: 'docked' },
  { windowMode: 'docked', alwaysOnTop: true },
  { alwaysOnTop: 'true' },
  { keepOpen: false, alwaysOnTop: true },
  { keepOpen: true },
  { trayProvider: 'codex', trayWindow: 'weekly', trayStyle: 'bars', trayColored: false },
  { trayProvider: 'claude', trayWindow: 'monthly', trayStyle: 'square', trayColored: 'yes' },
  { trayProvider: 'cursor', extra: { nested: true } },
];
const settingsCases = settingsInputs.map((input) => ({
  input,
  output: `${JSON.stringify(normalizeSettings(input), null, 2)}\n`,
}));

const window = {
  id: 'session',
  label: 'Session',
  usedPercent: 42.5,
  resetsAt: '2026-06-01T13:00:00.000Z',
  periodSeconds: 18_000,
  format: 'percent',
};
const snapshot = (provider, patch = {}) => ({
  provider,
  plan: 'Pro',
  windows: [window, { ...window, id: 'weekly', label: 'Weekly', usedValue: 3.5, limitValue: 20, format: 'dollars' }],
  values: [{ id: 'credits', label: 'Credits', value: 12.25, format: 'dollars' }],
  fetchedAt: '2026-06-01T12:00:00.000Z',
  ...patch,
});
const period = (tokens, cost) => ({
  tokens,
  costUSD: cost,
  hasCost: cost > 0,
  ...(tokens > 100 && { hasUnpricedTokens: true }),
  models: [{ model: 'claude-sonnet-4-6', tokens, costUSD: cost, hasCost: cost > 0 }],
});
const usage = {
  today: period(10, 0.5),
  yesterday: period(0, 0),
  last7Days: period(150, 2.25),
  last30Days: period(150, 2.25),
  allTime: period(1234, 17.125),
  daily: [
    { date: '2026-05-31', costUSD: 0.1, hasUnpricedTokens: true },
    { date: '2026-06-01', costUSD: 0, hasUnpricedTokens: false },
  ],
};
const entry = {
  project: 'acme/widget',
  tokens: 90,
  costUSD: 1,
  hasCost: true,
  providers: [{ key: 'claude_code', label: 'Claude Code', tokens: 90, costUSD: 1, hasCost: true }],
};
const rest = { ...entry, project: '(unattributed)', unattributed: true, hasUnpricedTokens: true };
const projects = { today: [entry, rest], last7Days: [entry], last30Days: [], allTime: [entry, rest] };
const machine = (name, patch = {}) => ({
  name,
  timezone: 'Europe/Berlin',
  lastUpdated: '2026-06-01T08:00:00.000Z',
  current: false,
  providers: { codex: usage },
  ...patch,
});
const full = {
  format: 2,
  updatedAt: '2026-06-01T12:00:00.000Z',
  usageUpdatedAt: '2026-06-01T11:59:00.000Z',
  pullError: 'Could not pull synced data: offline',
  quotas: { claude_code: snapshot('claude_code'), codex: snapshot('codex', { plan: undefined }), cursor: snapshot('cursor') },
  usage: {
    providers: { claude_code: usage, codex: usage, bogus: usage },
    projects,
    machines: [machine('desk', { current: true }), machine('laptop', { providers: [] })],
    account: { cursor: usage },
  },
  fired: { 'claude_code:session:almostOut': '2026-06-01T13:00:00.000Z' },
  rateLimitedUntil: { codex: 1_780_315_500_000, cursor: 1.5 },
};
const cacheInputs = [
  null,
  'garbage',
  { format: 1, updatedAt: '2026-06-01T12:00:00.000Z' },
  { format: 3 },
  { format: '2' },
  { format: 2 },
  full,
  { ...full, updatedAt: 'soon', usageUpdatedAt: 5, pullError: null },
  { ...full, updatedAt: '2026-06-01', usageUpdatedAt: '2026-06-01 12:00:00' },
  { format: 2, quotas: { claude_code: {}, codex: snapshot('cursor'), x: snapshot('x') } },
  { format: 2, quotas: { codex: snapshot('codex', { fetchedAt: 'soon' }) } },
  { format: 2, quotas: { codex: snapshot('codex', { plan: 7 }) } },
  { format: 2, quotas: { codex: snapshot('codex', { values: [{ id: 'a', label: 'A', value: 1, format: 'percent' }] }) } },
  { format: 2, quotas: { codex: snapshot('codex', { windows: [{ ...window, format: 'tokens' }] }) } },
  { format: 2, quotas: { codex: snapshot('codex', { windows: [{ ...window, resetsAt: null }] }) } },
  { format: 2, quotas: { codex: snapshot('codex', { windows: [{ ...window, usedValue: '1' }] }) } },
  { format: 2, quotas: { codex: snapshot('codex', { windows: [{ ...window, resetsAt: undefined }] }) } },
  { format: 2, usage: { providers: { codex: { ...usage, daily: [{ date: 1, costUSD: 0 }] } } } },
  { format: 2, usage: { providers: { codex: { ...usage, today: { ...usage.today, hasUnpricedTokens: 'yes' } } } } },
  { format: 2, usage: { providers: { codex: { ...usage, allTime: { ...usage.allTime, models: [{ tokens: 1 }] } } } } },
  { format: 2, usage: { providers: {}, projects: { ...projects, allTime: undefined } } },
  { format: 2, usage: { providers: {}, projects: { ...projects, today: [{ ...entry, providers: [{ key: 1 }] }] } } },
  { format: 2, usage: { providers: {}, machines: 'nope', account: [] } },
  { format: 2, usage: { machines: [{ name: 'old' }, machine('ok', { current: 'yes' }), machine('fine')] } },
  { format: 2, usage: 'nope', fired: [], rateLimitedUntil: { claude_code: '5', codex: null } },
  { format: 2, fired: { a: 'x', b: 1, c: null, d: '' } },
];
const cacheCases = cacheInputs.map((input) => ({ input, output: JSON.stringify(loadCachedState(input)) }));

// One case per line keeps diffs readable without the size of indented JSON.
const section = (name, cases) =>
  `${JSON.stringify(name)}: [\n${cases.map((value) => JSON.stringify(value)).join(',\n')}\n]`;
writeFileSync(
  join(here, 'expected.json'),
  `{\n${[section('tray', trayCases), section('settings', settingsCases), section('cache', cacheCases)].join(',\n')}\n}\n`,
);
