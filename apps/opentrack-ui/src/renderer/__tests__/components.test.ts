// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AppState,
  OpentrackApi,
  PeriodUsage,
  ProviderUsage,
  Settings,
} from '../../shared/types.js';
import { EMPTY_PERIOD } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../sidecar/settings.js';

const mocks = vi.hoisted(() => ({
  api: {
    getState: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    refresh: vi.fn(),
    sync: vi.fn(),
    fitHeight: vi.fn(),
    onState: vi.fn(),
    onSettings: vi.fn(),
    onScreen: vi.fn(),
    settingErrors: vi.fn(),
    onSettingErrors: vi.fn(),
    quit: vi.fn(),
    openDashboard: vi.fn(),
    appVersion: vi.fn(),
    checkForUpdate: vi.fn(),
    availableUpdate: vi.fn(),
    onUpdate: vi.fn(),
    installUpdate: vi.fn(),
  },
}));
vi.mock('../api.js', () => mocks);
import App from '../App.svelte';
import Dashboard from '../Dashboard.svelte';
import LimitMeter from '../LimitMeter.svelte';
import SettingsScreen from '../SettingsScreen.svelte';

window.matchMedia = () => ({ matches: false }) as MediaQueryList;
let target: HTMLDivElement;
let reportResize: (() => void) | undefined;
const mounted: Array<ReturnType<typeof mount>> = [];
const state: AppState = {
  providers: [],
  refreshing: false,
  syncing: false,
  machineCount: 1,
};
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}
function click(selector: string): void {
  const button = target.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button?.click();
}
function change(selector: string, value?: string): void {
  const input = target.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
  expect(input).not.toBeNull();
  if (input && value !== undefined) input.value = value;
  input?.dispatchEvent(new Event('change', { bubbles: true }));
}
function handlers() {
  return { onRefresh: vi.fn(), onSync: vi.fn(), onOpenDashboard: vi.fn() };
}
function listener<K extends 'onState' | 'onSettings' | 'onScreen' | 'onSettingErrors' | 'onUpdate'>(
  name: K,
): Parameters<OpentrackApi[K]>[0] {
  return mocks.api[name].mock.calls[0]?.[0] as Parameters<OpentrackApi[K]>[0];
}
function spent(tokens: number, costUSD: number, model: string): PeriodUsage {
  const hasCost = costUSD > 0;
  return { tokens, costUSD, hasCost, models: [{ model, tokens, costUSD, hasCost }] };
}
function usage(period: PeriodUsage, daily = [{ date: '2026-06-01', costUSD: 0 }]): ProviderUsage {
  return {
    today: period,
    yesterday: EMPTY_PERIOD,
    last7Days: period,
    last30Days: period,
    allTime: period,
    daily,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  Element.prototype.animate = () => ({}) as Animation;
  vi.spyOn(Element.prototype, 'animate').mockImplementation(
    () =>
      ({
        cancel() {},
        finish() {},
        play() {},
        pause() {},
        currentTime: 0,
        effect: { getComputedTiming: () => ({ progress: 1 }) },
        onfinish: null,
      }) as unknown as Animation,
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        reportResize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  target = document.createElement('div');
  document.body.append(target);
  mocks.api.getState.mockResolvedValue(state);
  mocks.api.getSettings.mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
  mocks.api.saveSettings.mockImplementation((settings: Settings) => Promise.resolve(settings));
  mocks.api.settingErrors.mockResolvedValue({});
  mocks.api.availableUpdate.mockResolvedValue(null);
  mocks.api.appVersion.mockResolvedValue('3.1.0');
  for (const name of [
    'onState',
    'onSettings',
    'onScreen',
    'onSettingErrors',
    'onUpdate',
  ] as const) {
    mocks.api[name].mockReturnValue(vi.fn());
  }
});
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  target.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('desktop commands and settings', () => {
  it('retains the newest queued settings after a failed delivery and retries it', async () => {
    let rejectSave: ((reason: Error) => void) | undefined;
    mocks.api.saveSettings.mockImplementationOnce(
      () =>
        new Promise<Settings>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    mounted.push(mount(App, { target }));
    await settle();
    click('[aria-label="Settings"]');
    await settle();
    change('#set-theme', 'dark');
    await settle();
    change('#set-display', 'left');
    await settle();
    expect(target.querySelector<HTMLSelectElement>('#set-display')?.value).toBe('left');
    expect(mocks.api.saveSettings).toHaveBeenCalledTimes(1);
    const externalSettings = listener('onSettings');
    externalSettings(DEFAULT_SETTINGS);
    rejectSave?.(new Error('bridge disconnected'));
    await settle();
    expect(target.textContent).toContain('Could not save settings: bridge disconnected');
    click('.banner button');
    await settle();
    expect(mocks.api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark', display: 'left' }),
    );
    expect(target.textContent).not.toContain('Could not save settings');
    click('[aria-label="Back"]');
    await settle();
    click('[aria-label="Keep open"]');
    await settle();
    expect(mocks.api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ windowMode: 'floating' }),
    );
    click('[aria-label="Close with the tray again"]');
    await settle();
    expect(mocks.api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ windowMode: 'popup' }),
    );
    mocks.api.refresh.mockRejectedValueOnce(new Error('refresh delivery'));
    click('[aria-label="Refresh"]');
    await settle();
    expect(target.textContent).toContain('Refresh could not be sent: refresh delivery');
    click('.banner button');
    await settle();
    expect(mocks.api.refresh).toHaveBeenCalledTimes(2);
    mocks.api.sync.mockRejectedValueOnce(new Error('sync delivery'));
    click('[aria-label="Sync this machine"]');
    await settle();
    click('.banner button');
    await settle();
    expect(mocks.api.sync).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('focus'));
    await settle();
  });

  it('retries failed startup and accepts pushed state and settings', async () => {
    mocks.api.getState.mockRejectedValue(new Error('offline'));
    mounted.push(mount(App, { target }));
    await settle();
    expect(target.textContent).toContain('Loading');
    expect(target.textContent).toContain('Could not load dashboard: offline');
    click('[aria-label="Refresh"]');
    await settle();
    expect(target.textContent).toContain('Could not load dashboard: offline');
    click('.banner button');
    await settle();
    expect(mocks.api.getState).toHaveBeenCalledTimes(2);
    const onState = listener('onState');
    onState({ ...state, refreshing: true });
    const onSettings = listener('onSettings');
    onSettings({ ...DEFAULT_SETTINGS, windowMode: 'floating' });
    await settle();
    expect(target.textContent).not.toContain('Could not load dashboard');
    expect(target.textContent).not.toContain('Loading');
    expect(target.textContent).toContain('Updating');
    onState({ ...state, syncing: true });
    await settle();
    expect(target.textContent).toContain('Syncing');
    const live = () => target.querySelector('[role="status"][aria-live="polite"]')?.textContent;
    expect(live()).toBe('Syncing…');
    onState({ ...state, syncResult: { ok: true, message: 'Synced 2 files' } });
    await settle();
    expect(live()).toBe('Synced 2 files');
    onState({ ...state, refreshing: true });
    await settle();
    onState({ ...state });
    await settle();
    expect(live()).toBe('Usage updated');
    const onScreen = listener('onScreen');
    onScreen('settings');
    await settle();
    expect(target.querySelector('h1')?.textContent).toBe('Settings');
  });

  it('delivers provider reorder, toggles, display preferences and setting errors', async () => {
    const patch = vi.fn();
    const back = vi.fn();
    mocks.api.settingErrors.mockResolvedValue({
      globalShortcut: 'Shortcut unavailable',
      launchAtLogin: 'Login item denied',
    });
    mounted.push(
      mount(SettingsScreen, {
        target,
        props: {
          settings: { ...DEFAULT_SETTINGS, trayStyle: 'icon' },
          onPatch: patch,
          onBack: back,
        },
      }),
    );
    await settle();
    click('[aria-label="Move Claude Code down"]');
    click('[aria-label="Move Codex up"]');
    for (const input of target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (const select of target.querySelectorAll<HTMLSelectElement>('select'))
      change(`#${select.id}`, select.options[1]?.value);
    change('#set-shortcut', 'Ctrl+Shift+U');
    click('[aria-label="Back"]');
    click('.quit');
    await settle();
    expect(back).toHaveBeenCalled();
    expect(mocks.api.quit).toHaveBeenCalled();
    expect(patch).toHaveBeenCalledWith({ globalShortcut: 'Ctrl+Shift+U' });
    expect(target.textContent).toContain('Shortcut unavailable');
    const login = target.querySelector('#set-login');
    expect(login?.getAttribute('aria-invalid')).toBe('true');
    expect(target.querySelector(`#${login?.getAttribute('aria-describedby')}`)?.textContent).toBe(
      'Login item denied',
    );
    const callback = listener('onSettingErrors');
    callback({});
    await settle();
    expect(target.textContent).not.toContain('Shortcut unavailable');
    expect(target.textContent).not.toContain('Login item denied');
    expect(login?.getAttribute('aria-invalid')).toBe('false');
  });
});

it('shows partial costs and cached ages, exposes provider controls and operation failures', async () => {
  const partial = {
    ...EMPTY_PERIOD,
    tokens: 30,
    costUSD: 2,
    hasCost: true,
    hasUnpricedTokens: true,
    models: [{ model: 'mixed', tokens: 30, costUSD: 2, hasCost: true, hasUnpricedTokens: true }],
  };
  const now = Date.parse('2026-06-01T12:00:00Z');
  const appState: AppState = {
    ...state,
    machineCount: 2,
    pullError: 'Pull unavailable',
    usageError: 'Read unavailable',
    usageUpdatedAt: new Date(now - 600_000).toISOString(),
    syncResult: { ok: false, message: 'Remote unavailable' },
    providers: [
      {
        key: 'claude_code',
        label: 'Claude Code',
        refreshing: true,
        quotaError: { kind: 'network', message: 'offline' },
        quota: {
          provider: 'claude_code',
          fetchedAt: new Date(now - 600_000).toISOString(),
          plan: 'Pro',
          values: [{ id: 'credits', label: 'Credits', value: 2, format: 'dollars' }],
          windows: [
            {
              id: 'session',
              label: 'Session',
              usedPercent: 40,
              periodSeconds: 18_000,
              resetsAt: new Date(now + 3600_000).toISOString(),
              format: 'percent',
            },
          ],
        },
        usage: usage(partial, [
          { date: '2026-06-01', costUSD: 2 },
          { date: '2026-05-31', costUSD: 1 },
        ]),
      },
    ],
  };
  const patch = vi.fn();
  const period = vi.fn();
  const refresh = vi.fn();
  mounted.push(
    mount(Dashboard, {
      target,
      props: {
        appState,
        settings: DEFAULT_SETTINGS,
        now,
        period: 'today',
        onPeriod: period,
        onPatch: patch,
        ...handlers(),
        onRefresh: refresh,
      },
    }),
  );
  await settle();
  expect(target.textContent).toContain('Partial estimate');
  expect(target.textContent).toContain('(partial)');
  expect(target.textContent).toContain('Cached limits');
  expect(target.textContent).toContain('Cached usage');
  expect(target.textContent).toContain('Pull unavailable');
  expect(target.textContent).toContain('Sync failed');
  click('.p-head');
  await settle();
  expect(target.textContent).toContain('mixed');
  click('[title="Show used or left"]');
  click('[title="Show time or countdown"]');
  expect(patch).toHaveBeenCalledWith({ display: 'left' });
  expect(patch).toHaveBeenCalledWith({ resetDisplay: 'relative' });
  for (const button of target.querySelectorAll<HTMLButtonElement>('.seg button')) button.click();
  expect(period).toHaveBeenCalledTimes(4);
  click('.state button');
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('compares machines by share, activity and freshness, with account-wide usage apart', async () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const appState: AppState = {
    ...state,
    machineCount: 3,
    providers: [
      { key: 'claude_code', label: 'Claude Code', refreshing: false },
      { key: 'cursor', label: 'Cursor', refreshing: false },
      { key: 'vibe', label: 'Mistral Vibe', refreshing: false },
    ],
    machines: [
      {
        name: 'laptop',
        timezone: 'UTC',
        lastUpdated: '',
        current: true,
        providers: {
          claude_code: usage(spent(100, 1, 'sonnet'), [
            { date: '2026-05-31', costUSD: 4 },
            { date: '2026-06-01', costUSD: 1 },
          ]),
        },
      },
      {
        name: 'desk',
        timezone: 'Asia/Tokyo',
        lastUpdated: new Date(now - 10 * 86_400_000).toISOString(),
        current: false,
        providers: { claude_code: usage(spent(300, 3, 'opus')), codex: usage(spent(9, 9, 'gpt')) },
      },
      { name: 'idle', timezone: 'UTC', lastUpdated: '', current: false, providers: {} },
    ],
    accountUsage: { cursor: usage(spent(50, 0, 'auto')) },
  };
  const view = vi.fn();
  const props = {
    appState,
    settings: DEFAULT_SETTINGS,
    now,
    period: 'today' as const,
    view: 'providers' as const,
    onPeriod: vi.fn(),
    onView: view,
    onPatch: vi.fn(),
    ...handlers(),
  };
  const tabs = mount(Dashboard, { target, props });
  await settle();
  expect(target.querySelector('.machines')).toBeNull();
  expect(target.textContent).toContain('Checking limits');
  expect(target.querySelector('.provider--vibe .state')).toBeNull(); // No limits to check.
  expect(target.querySelector<HTMLButtonElement>('.p-head')?.disabled).toBe(true);
  click('.sub-link');
  for (const tab of target.querySelectorAll<HTMLButtonElement>('[role="tab"]')) tab.click();
  expect(view.mock.calls).toEqual([
    ['machines'],
    ['providers'],
    ['history'],
    ['projects'],
    ['machines'],
  ]);
  const list = target.querySelector('[role="tablist"]');
  list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  expect(view.mock.calls.slice(5)).toEqual([['history'], ['machines']]);

  await unmount(tabs);
  const machinesView = mount(Dashboard, { target, props: { ...props, view: 'machines' } });
  await settle();
  const names = [...target.querySelectorAll('.m-name')].map((name) => name.textContent.trim());
  // By spend; Codex is turned off, so desk's $9 of it does not count.
  expect(names).toEqual(['desk', 'laptop This machine', 'Cursor account', 'idle']);
  expect([...target.querySelectorAll('.m-percent')].map((cell) => cell.textContent)).toEqual([
    '75%',
    '25%',
  ]);
  expect(target.textContent).toContain('Live · not synced yet');
  expect(target.textContent).toContain('Synced 10d 0h ago');
  expect(target.querySelectorAll('.m-dot.stale')).toHaveLength(2);
  expect(target.textContent).toContain('there');
  expect(target.textContent).toContain('Account-wide');
  expect(
    [...target.querySelectorAll<HTMLElement>('.m-cell')].map((cell) => cell.dataset.level),
  ).toContain('4');
  const heads = target.querySelectorAll<HTMLButtonElement>('.m-head');
  heads[0]?.click();
  await settle();
  expect(target.querySelector('.details')?.textContent).toContain('opus');
  heads[3]?.click();
  await settle();
  expect(target.textContent).toContain('No usage · Today');
  heads[3]?.click();
  await unmount(machinesView);

  // Unpriced, so shares follow tokens; Cursor is off, so its account row stays out.
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lone = { name: 'solo', timezone: here, lastUpdated: '', current: true, providers: {} };
  for (const providers of [{ claude_code: usage(spent(30, 0, 'x')) }, {}]) {
    const view = mount(Dashboard, {
      target,
      props: {
        ...props,
        view: 'machines',
        appState: {
          ...appState,
          providers: [{ key: 'claude_code', label: 'Claude Code', refreshing: false }],
          machines: [{ ...lone, providers }],
        },
      },
    });
    await settle();
    click('.m-head');
    await settle();
    expect(target.textContent).not.toContain('there');
    expect(target.textContent).not.toContain('Cursor account');
    expect(target.textContent).toContain('aitrack init');
    await unmount(view);
  }
});

function projectPart(key: string, label: string, tokens: number, costUSD: number) {
  return { key, label, tokens, costUSD, hasCost: costUSD > 0 };
}

it('lists projects by share with a provider split, the unattributed remainder last, and an empty state', async () => {
  const entries = [
    {
      project: 'acme/widget',
      tokens: 300,
      costUSD: 3,
      hasCost: true,
      providers: [
        projectPart('claude_code', 'Claude Code', 200, 2),
        projectPart('codex', 'Codex', 100, 1),
      ],
    },
    { project: 'free/unpriced', tokens: 5, costUSD: 0, hasCost: false, providers: [] },
    {
      project: '(unattributed)',
      unattributed: true,
      tokens: 100,
      costUSD: 1,
      hasCost: true,
      providers: [projectPart('codex', 'Codex', 100, 1)],
    },
  ];
  const projects = { today: [], last7Days: entries, last30Days: [], allTime: [] };
  const props = {
    appState: {
      ...state,
      providers: [{ key: 'claude_code' as const, label: 'Claude Code', refreshing: false }],
      projects,
    },
    settings: DEFAULT_SETTINGS,
    now: Date.parse('2026-06-10T12:00:00Z'),
    period: 'week' as const,
    view: 'projects' as const,
    onPeriod: vi.fn(),
    onView: vi.fn(),
    onPatch: vi.fn(),
    ...handlers(),
  };
  const list = mount(Dashboard, { target, props });
  await settle();
  expect([...target.querySelectorAll('.m-name')].map((name) => name.textContent)).toEqual([
    'acme/widget',
    'free/unpriced',
    '(unattributed)',
  ]);
  expect([...target.querySelectorAll('.m-percent')].map((cell) => cell.textContent)).toEqual([
    '75%',
    '25%',
  ]);
  expect(target.querySelector('.project.remainder .m-name')?.textContent).toBe('(unattributed)');
  expect(target.textContent).toContain('Cursor is not attributed');
  expect(target.querySelector('.details')).toBeNull();
  click('.m-head');
  await settle();
  expect(target.querySelector('.details')?.textContent).toContain('Codex');
  click('.m-head');
  await unmount(list);

  // Unpriced projects share by tokens; no projects explains how they appear.
  const unpriced = mount(Dashboard, {
    target,
    props: {
      ...props,
      period: 'all' as const,
      appState: {
        ...props.appState,
        projects: {
          ...projects,
          allTime: [{ ...entries[0], costUSD: 0, hasCost: false }],
        },
      },
    },
  });
  await settle();
  expect(target.querySelector('.m-share')?.getAttribute('title')).toContain('of tokens');
  await unmount(unpriced);
  const empty = mount(Dashboard, {
    target,
    props: {
      ...props,
      period: 'month' as const,
      appState: { ...props.appState, projects: undefined },
    },
  });
  await settle();
  expect(target.textContent).toContain('No project usage 30 days.');
  expect(target.textContent).toContain('from the next sync or refresh onward');
  await unmount(empty);
});

it('charts spend history by provider and switches range and grouping', async () => {
  const days = Array.from({ length: 40 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 4, 1 + index)).toISOString().slice(0, 10),
    costUSD: index === 10 ? 20 : 1,
  }));
  const appState: AppState = {
    ...state,
    providers: [
      {
        key: 'claude_code',
        label: 'Claude Code',
        refreshing: false,
        usage: usage(spent(100, 1, 'opus'), days),
      },
      { key: 'codex', label: 'Codex', refreshing: false },
    ],
  };
  const props = {
    appState,
    settings: DEFAULT_SETTINGS,
    now: Date.parse('2026-06-10T12:00:00Z'),
    period: 'today' as const,
    view: 'history' as const,
    onPeriod: vi.fn(),
    onView: vi.fn(),
    onPatch: vi.fn(),
    ...handlers(),
  };
  const history = mount(Dashboard, { target, props });
  await settle();
  expect(target.querySelectorAll('.h-bar')).toHaveLength(30);
  expect(target.textContent).toContain('peak $20.00');
  expect(target.textContent).toContain('2026-05-11'); // the busiest day

  const [thirty, ninety, , week] = target.querySelectorAll<HTMLButtonElement>('.h-controls button');
  ninety?.click();
  await settle();
  expect(target.querySelectorAll('.h-bar')).toHaveLength(40);
  week?.click();
  await settle();
  expect(target.querySelectorAll('.h-bar').length).toBeLessThan(10);
  thirty?.click();
  await unmount(history);

  const empty = mount(Dashboard, {
    target,
    props: { ...props, appState: { ...appState, providers: appState.providers.slice(1) } },
  });
  await settle();
  expect(target.textContent).toContain('No priced usage');
  await unmount(empty);
});

it('renders remaining quotas with and without reset metadata and delivers toggles', async () => {
  const patch = vi.fn<(value: Partial<Settings>) => void>();
  mounted.push(
    mount(Dashboard, {
      target,
      props: {
        appState: {
          ...state,
          providers: [
            {
              key: 'codex',
              label: 'Codex',
              refreshing: false,
              quota: {
                provider: 'codex',
                fetchedAt: new Date().toISOString(),
                values: [{ id: 'n', label: 'Requests', value: 10, format: 'number' }],
                windows: [
                  {
                    id: 'session',
                    label: 'Session',
                    usedPercent: 20,
                    format: 'percent',
                    periodSeconds: 18_000,
                    resetsAt: new Date(Date.now() + 3600_000).toISOString(),
                  },
                  { id: 'unknown', label: 'Unscheduled', usedPercent: 0, format: 'percent' },
                ],
              },
              usage: usage(EMPTY_PERIOD, []),
            },
          ],
        },
        settings: { ...DEFAULT_SETTINGS, display: 'left', resetDisplay: 'relative' },
        now: Date.now(),
        period: 'all',
        onPeriod: () => {},
        onPatch: patch,
        ...handlers(),
      },
    }),
  );
  await settle();
  click('[title="Show used or left"]');
  click('[title="Show time or countdown"]');
  expect(patch).toHaveBeenCalledWith({ display: 'used' });
  expect(patch).toHaveBeenCalledWith({ resetDisplay: 'absolute' });
  expect(target.textContent).toContain('Unscheduled');
  expect(target.querySelector('.spark')).toBeNull();
});

it('falls back to automatic tray selection when its provider is disabled and handles unavailable setting errors', async () => {
  mocks.api.settingErrors.mockRejectedValue(new Error('bridge unavailable'));
  const patch = vi.fn<(value: Partial<Settings>) => void>();
  mounted.push(
    mount(SettingsScreen, {
      target,
      props: {
        settings: {
          ...DEFAULT_SETTINGS,
          trayStyle: 'bars',
          trayProvider: 'cursor',
          providers: DEFAULT_SETTINGS.providers.map((provider) => ({
            ...provider,
            enabled: provider.key === 'vibe',
          })),
        },
        onPatch: patch,
        onBack: () => {},
      },
    }),
  );
  await settle();
  const tray = target.querySelector<HTMLSelectElement>('#set-tray-provider');
  expect(tray?.value).toBe('auto');
  expect([...(tray?.options ?? [])].map((option) => option.value)).toEqual(['auto']);
  expect(target.querySelector('#set-tray-window')).toBeNull();
  expect(target.textContent).toContain('All providers');
  const toggle = target.querySelector<HTMLInputElement>('[aria-label="Show Cursor"]');
  if (!toggle) throw new Error('missing provider control');
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  expect(
    patch.mock.calls.at(-1)?.[0].providers?.find((entry) => entry.key === 'cursor')?.enabled,
  ).toBe(true);
});

it('updates quota meters and settings controls when the sidecar pushes new values', async () => {
  const now = Date.now();
  const provider = {
    key: 'codex' as const,
    label: 'Codex',
    refreshing: false,
    quota: {
      provider: 'codex' as const,
      fetchedAt: new Date(now).toISOString(),
      values: [],
      windows: [
        {
          id: 'session',
          label: 'Session',
          usedPercent: 40,
          periodSeconds: 18_000,
          resetsAt: new Date(now + 3600_000).toISOString(),
          format: 'percent' as const,
        },
      ],
    },
  };
  mocks.api.getState.mockResolvedValue({ ...state, providers: [provider] });
  mounted.push(mount(App, { target }));
  await settle();
  const onState = listener('onState');
  const onSettings = listener('onSettings');
  onSettings({ ...DEFAULT_SETTINGS, display: 'left', resetDisplay: 'relative' });
  await settle();
  const meter = target.querySelector('[role="meter"]');
  expect(meter?.getAttribute('aria-valuenow')).toBe('60');
  expect(meter?.getAttribute('aria-valuetext')).toBe('60% left');
  onState({
    ...state,
    providers: [
      {
        ...provider,
        quota: {
          ...provider.quota,
          windows: [
            {
              ...provider.quota.windows[0],
              id: 'session',
              label: 'Reached',
              usedPercent: 100,
              periodSeconds: 18_000,
              format: 'percent',
              resetsAt: undefined,
            },
          ],
        },
      },
    ],
  });
  await settle();
  expect(target.textContent).toContain('Limit reached');
  expect(target.querySelector('.tick')).toBeNull();
  click('[aria-label="Settings"]');
  await settle();
  onSettings({
    ...DEFAULT_SETTINGS,
    theme: 'dark',
    trayStyle: 'bars',
    trayProvider: 'codex',
    trayColored: true,
    resetDisplay: 'relative',
    display: 'left',
    providers: DEFAULT_SETTINGS.providers.toReversed(),
  });
  await settle();
  expect(target.querySelector<HTMLSelectElement>('#set-theme')?.value).toBe('dark');
  onSettings({
    ...DEFAULT_SETTINGS,
    providers: DEFAULT_SETTINGS.providers.map((entry) => ({ ...entry, enabled: false })),
  });
  await settle();
  expect(target.querySelector<HTMLSelectElement>('#set-tray-provider')?.options).toHaveLength(1);
});

it('shows a reset without projecting pace when the period duration is unknown', async () => {
  const now = Date.now();
  mounted.push(
    mount(LimitMeter, {
      target,
      props: {
        window: {
          id: 'unknown',
          label: 'Unknown period',
          usedPercent: 30,
          periodSeconds: 0,
          resetsAt: new Date(now + 3600_000).toISOString(),
          format: 'percent',
        },
        settings: DEFAULT_SETTINGS,
        now,
        onToggleUsage: () => {},
        onToggleReset: () => {},
      },
    }),
  );
  await settle();
  expect(target.querySelector('[title="Show time or countdown"]')).not.toBeNull();
  expect(target.querySelector('.l-pace')).toBeNull();
  expect(target.querySelector('.tick')).toBeNull();
});

it('guards provider moves at list boundaries even if a disabled control receives an event', async () => {
  const patch = vi.fn<(value: Partial<Settings>) => void>();
  mounted.push(
    mount(SettingsScreen, {
      target,
      props: { settings: DEFAULT_SETTINGS, onPatch: patch, onBack: () => {} },
    }),
  );
  await settle();
  const first = target.querySelector('[aria-label="Move Claude Code up"]');
  const last = target.querySelector('[aria-label="Move Mistral Vibe down"]');
  first?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  last?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
  expect(patch).not.toHaveBeenCalled();
});

it('retries failed operations separately from command delivery', async () => {
  mocks.api.getState.mockResolvedValue({
    ...state,
    usageError: 'read failed',
    pullError: 'pull failed',
    syncResult: { ok: false, message: 'remote failed' },
    providers: [
      {
        key: 'cursor',
        label: 'Cursor',
        refreshing: false,
        quotaError: { kind: 'noCredentials', message: 'signed out' },
      },
    ],
  });
  mounted.push(mount(App, { target }));
  await settle();
  click('[aria-label="Retry pull"]');
  await settle();
  click('[aria-label="Retry usage"]');
  await settle();
  expect(mocks.api.refresh).toHaveBeenCalledTimes(2);
  mocks.api.sync.mockRejectedValueOnce(new Error('bridge closed'));
  click('[aria-label="Retry sync"]');
  await settle();
  expect(target.textContent).toContain('Sync failed: remote failed');
  expect(target.textContent).toContain('Sync could not be sent: bridge closed');
  click('[role="alert"] button');
  await settle();
  expect(mocks.api.sync).toHaveBeenCalledTimes(2);
  mocks.api.openDashboard.mockRejectedValueOnce(new Error('opener denied'));
  click('.state button');
  await settle();
  expect(mocks.api.openDashboard).toHaveBeenCalledWith('cursor');
  expect(target.textContent).toContain('Open dashboard could not be sent: opener denied');
});

it('offers a found update and retries a failed install', async () => {
  mounted.push(mount(App, { target }));
  await settle();
  expect(target.textContent).not.toContain('is available');
  const onUpdate = listener('onUpdate');
  onUpdate('3.1.0');
  await settle();
  expect(target.textContent).toContain('opentrack 3.1.0 is available.');
  mocks.api.installUpdate.mockRejectedValueOnce(new Error('signature mismatch'));
  click('[role="status"] button');
  await settle();
  expect(target.textContent).toContain('Could not install opentrack 3.1.0: signature mismatch');
  mocks.api.installUpdate.mockReturnValueOnce(new Promise(() => {}));
  click('[role="alert"] button');
  await settle();
  expect(target.textContent).toContain('Installing opentrack 3.1.0');
  expect(mocks.api.installUpdate).toHaveBeenCalledTimes(2);
});

it('fits the window to the unrounded height of the content and footer', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return { height: this.classList.contains('foot') ? 41.5 : 600.25 } as DOMRect;
  });
  mounted.push(mount(App, { target }));
  await settle();
  reportResize?.();
  expect(mocks.api.fitHeight).toHaveBeenLastCalledWith(641.75);
});

it('shows the version and checks for and installs updates from settings', async () => {
  const button = (text: string) =>
    [...target.querySelectorAll('button')].find((element) => element.textContent === text);
  mocks.api.checkForUpdate.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
  mounted.push(mount(App, { target }));
  await settle();
  click('[aria-label="Settings"]');
  await settle();
  expect(target.querySelector('.row-value')?.textContent).toBe('3.1.0');
  expect(target.textContent).toContain('Checked every 6 hours');
  button('Check now')?.click();
  await settle();
  expect(target.textContent).toContain('Could not check: offline');
  button('Check now')?.click();
  await settle();
  expect(target.textContent).toContain('Up to date');
  const onUpdate = listener('onUpdate');
  onUpdate('3.2.0');
  await settle();
  expect(target.textContent).toContain('3.2.0 is available');
  mocks.api.installUpdate.mockReturnValueOnce(new Promise(() => {}));
  button('Install and restart')?.click();
  await settle();
  expect(mocks.api.installUpdate).toHaveBeenCalledTimes(1);
  expect(target.textContent).toContain('Installing 3.2.0');
});
