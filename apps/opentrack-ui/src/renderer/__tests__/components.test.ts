// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppState, OpentrackApi, Settings } from '../../shared/types.js';
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
    shortcutError: vi.fn(),
    onShortcutError: vi.fn(),
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
import SettingsScreen from '../SettingsScreen.svelte';

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
  mocks.api.shortcutError.mockResolvedValue(null);
  mocks.api.availableUpdate.mockResolvedValue(null);
  mocks.api.appVersion.mockResolvedValue('3.1.0');
  for (const name of [
    'onState',
    'onSettings',
    'onScreen',
    'onShortcutError',
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
    expect(mocks.api.saveSettings).toHaveBeenCalledTimes(1);
    const externalSettings = mocks.api.onSettings.mock.calls[0]?.[0] as Parameters<
      OpentrackApi['onSettings']
    >[0];
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
    click('[aria-label="Close with the tray again"]');
    await settle();
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
    mocks.api.getState.mockRejectedValueOnce(new Error('offline'));
    mounted.push(mount(App, { target }));
    await settle();
    expect(target.textContent).toContain('Loading');
    expect(target.textContent).toContain('Could not load dashboard: offline');
    click('[aria-label="Refresh"]');
    await settle();
    expect(target.textContent).toContain('Could not load dashboard: offline');
    click('.banner button');
    await settle();
    expect(target.textContent).not.toContain('Could not load dashboard');
    expect(target.textContent).not.toContain('Loading');
    const onState = mocks.api.onState.mock.calls[0]?.[0] as Parameters<OpentrackApi['onState']>[0];
    onState({ ...state, refreshing: true });
    const onSettings = mocks.api.onSettings.mock.calls[0]?.[0] as Parameters<
      OpentrackApi['onSettings']
    >[0];
    onSettings({ ...DEFAULT_SETTINGS, windowMode: 'floating' });
    await settle();
    expect(target.textContent).toContain('Updating');
    onState({ ...state, syncing: true });
    await settle();
    expect(target.textContent).toContain('Syncing');
    const onScreen = mocks.api.onScreen.mock.calls[0]?.[0] as Parameters<
      OpentrackApi['onScreen']
    >[0];
    onScreen('settings');
    await settle();
    expect(target.querySelector('h1')?.textContent).toBe('Settings');
  });

  it('delivers provider reorder, toggles, display preferences and shortcut controls', async () => {
    const patch = vi.fn();
    const back = vi.fn();
    mocks.api.shortcutError.mockResolvedValue('Shortcut unavailable');
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
    const callback = mocks.api.onShortcutError.mock.calls[0]?.[0] as (error: string | null) => void;
    callback(null);
    await settle();
    expect(target.textContent).not.toContain('Shortcut unavailable');
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
        usage: {
          today: partial,
          yesterday: EMPTY_PERIOD,
          last7Days: partial,
          last30Days: partial,
          allTime: partial,
          daily: [
            { date: '2026-06-01', costUSD: 2 },
            { date: '2026-05-31', costUSD: 1 },
          ],
        },
      },
    ],
  };
  const patch = vi.fn();
  const period = vi.fn();
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
  mocks.api.refresh.mockRejectedValueOnce(new Error('closed'));
  click('.state button');
  await settle();
  expect(target.textContent).toContain('Could not send');
  click('.state button');
  await settle();
  expect(target.textContent).not.toContain('Could not send');
});

it('renders unavailable and signed-out providers and all-time totals without a chart', async () => {
  const period = vi.fn<(value: string) => void>();
  const patch = vi.fn<(value: Partial<Settings>) => void>();
  const props = {
    appState: {
      ...state,
      providers: [
        {
          key: 'cursor' as const,
          label: 'Cursor',
          refreshing: false,
          quotaError: { kind: 'noCredentials' as const, message: 'signed out' },
        },
        { key: 'codex' as const, label: 'Codex', refreshing: false },
      ],
    },
    settings: { ...DEFAULT_SETTINGS, display: 'left' as const, resetDisplay: 'relative' as const },
    now: Date.now(),
    period: 'all' as const,
    onPeriod: period,
    onPatch: patch,
  };
  mounted.push(mount(Dashboard, { target, props }));
  await settle();
  expect(target.textContent).toContain('Checking limits');
  expect(target.querySelector('.spark')).toBeNull();
  click('.state button');
  await settle();
  expect(mocks.api.openDashboard).toHaveBeenCalledWith('cursor');
  expect(target.querySelector<HTMLButtonElement>('.p-head')?.disabled).toBe(true);
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
              usage: {
                today: EMPTY_PERIOD,
                yesterday: EMPTY_PERIOD,
                last7Days: EMPTY_PERIOD,
                last30Days: EMPTY_PERIOD,
                allTime: EMPTY_PERIOD,
                daily: [],
              },
            },
          ],
        },
        settings: { ...DEFAULT_SETTINGS, display: 'left', resetDisplay: 'relative' },
        now: Date.now(),
        period: 'all',
        onPeriod: () => {},
        onPatch: patch,
      },
    }),
  );
  await settle();
  click('[title="Show used or left"]');
  click('[title="Show time or countdown"]');
  expect(patch).toHaveBeenCalledWith({ display: 'used' });
  expect(patch).toHaveBeenCalledWith({ resetDisplay: 'absolute' });
  expect(target.textContent).toContain('Unscheduled');
});

it('falls back to automatic tray selection when its provider is disabled and handles unavailable shortcut diagnostics', async () => {
  mocks.api.shortcutError.mockRejectedValue(new Error('bridge unavailable'));
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
            enabled: false,
          })),
        },
        onPatch: patch,
        onBack: () => {},
      },
    }),
  );
  await settle();
  expect(target.querySelector<HTMLSelectElement>('#set-tray-provider')?.value).toBe('auto');
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
  const onState = mocks.api.onState.mock.calls[0]?.[0] as Parameters<OpentrackApi['onState']>[0];
  const onSettings = mocks.api.onSettings.mock.calls[0]?.[0] as Parameters<
    OpentrackApi['onSettings']
  >[0];
  onSettings({ ...DEFAULT_SETTINGS, display: 'left', resetDisplay: 'relative' });
  await settle();
  expect(target.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('60');
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

import LimitMeter from '../LimitMeter.svelte';
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
  const last = target.querySelector('[aria-label="Move Cursor down"]');
  first?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  last?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
  expect(patch).not.toHaveBeenCalled();
});

it('applies saved preferences back to every settings control', async () => {
  mounted.push(mount(App, { target }));
  await settle();
  click('[aria-label="Settings"]');
  await settle();
  for (const selector of ['#set-reset', '#set-tray-provider', '#set-tray-style']) {
    const select = target.querySelector<HTMLSelectElement>(selector);
    change(selector, select?.options[1]?.value);
    await settle();
  }
  for (const input of target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  }
  expect(mocks.api.saveSettings).toHaveBeenCalled();
  expect(target.querySelector<HTMLSelectElement>('#set-tray-style')?.value).toBe('bars');
});

it('keeps provider toggles usable when label metadata is absent at runtime', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const first = settings.providers[0];
  if (!first) throw new Error('missing provider');
  Reflect.deleteProperty(first, 'label');
  const patch = vi.fn<(value: Partial<Settings>) => void>();
  mounted.push(
    mount(SettingsScreen, { target, props: { settings, onPatch: patch, onBack: () => {} } }),
  );
  await settle();
  const toggle = target.querySelector<HTMLInputElement>('[aria-label="Show "]');
  expect(toggle).not.toBeNull();
  toggle?.dispatchEvent(new Event('change', { bubbles: true }));
  expect(patch).toHaveBeenCalled();
});

it('retries failed operations separately from command delivery', async () => {
  mocks.api.getState.mockResolvedValue({
    ...state,
    usageError: 'read failed',
    pullError: 'pull failed',
    syncResult: { ok: false, message: 'remote failed' },
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
});

it('offers a found update and retries a failed install', async () => {
  mounted.push(mount(App, { target }));
  await settle();
  expect(target.textContent).not.toContain('is available');
  const onUpdate = mocks.api.onUpdate.mock.calls[0]?.[0] as Parameters<OpentrackApi['onUpdate']>[0];
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
  const onUpdate = mocks.api.onUpdate.mock.calls[0]?.[0] as Parameters<OpentrackApi['onUpdate']>[0];
  onUpdate('3.2.0');
  await settle();
  expect(target.textContent).toContain('3.2.0 is available');
  mocks.api.installUpdate.mockReturnValueOnce(new Promise(() => {}));
  button('Install and restart')?.click();
  await settle();
  expect(mocks.api.installUpdate).toHaveBeenCalledTimes(1);
  expect(target.textContent).toContain('Installing 3.2.0');
});
