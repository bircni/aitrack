// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AppState,
  DailyUsage,
  PeriodUsage,
  ProviderUsage,
  Settings,
} from '../../shared/types.js';
import { EMPTY_PERIOD } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../sidecar/settings.js';
import type { api } from '../api.js';

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
    hideWindow: vi.fn(),
    serviceStatus: vi.fn(),
    onServiceStatus: vi.fn(),
  },
}));
vi.mock('../api.js', () => mocks);
import App from '../App.svelte';
import CompactLimit from '../CompactLimit.svelte';
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
function escape(from: Element | Window = window): void {
  from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}
function handlers() {
  return { onRefresh: vi.fn(), onSync: vi.fn(), onOpenDashboard: vi.fn() };
}
function listener<
  K extends
    | 'onState'
    | 'onSettings'
    | 'onScreen'
    | 'onSettingErrors'
    | 'onUpdate'
    | 'onServiceStatus',
>(name: K): Parameters<(typeof api)[K]>[0] {
  return mocks.api[name].mock.calls[0]?.[0] as Parameters<(typeof api)[K]>[0];
}
function spent(tokens: number, costUSD: number, model: string): PeriodUsage {
  const hasCost = costUSD > 0;
  return { tokens, costUSD, hasCost, models: [{ model, tokens, costUSD, hasCost }] };
}
function usage(
  period: PeriodUsage,
  daily: DailyUsage[] = [{ date: '2026-06-01', costUSD: 0 }],
): ProviderUsage {
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
  mocks.api.serviceStatus.mockResolvedValue({ state: 'running', message: null });
  for (const name of [
    'onState',
    'onSettings',
    'onScreen',
    'onSettingErrors',
    'onUpdate',
    'onServiceStatus',
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
    click('[aria-label="Compact view"]');
    await settle();
    expect(mocks.api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ compact: true }),
    );
    expect(target.querySelector('[aria-label="Compact view"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    click('[aria-label="Compact view"]');
    await settle();
    expect(mocks.api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ compact: false }),
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
    expect(target.textContent).not.toContain('Loading');
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
    onSettings(DEFAULT_SETTINGS);
    await settle();
    expect(target.textContent).not.toContain('Could not load dashboard');
    expect(target.textContent).not.toContain('Loading');
    expect(target.textContent).toContain('Updating');
    onState({ ...state, syncing: true });
    await settle();
    expect(target.textContent).toContain('Syncing');
    const onScreen = listener('onScreen');
    onScreen('settings');
    await settle();
    expect(target.querySelector('h1')?.textContent).toBe('Settings');
  });

  it('shows the down banner once pushed state has replaced a failed first load', async () => {
    mocks.api.getState.mockRejectedValue(new Error('did not respond'));
    mocks.api.getSettings.mockRejectedValue(new Error('did not respond'));
    mounted.push(mount(App, { target }));
    await settle();
    listener('onSettings')(DEFAULT_SETTINGS);
    listener('onState')(state);
    listener('onServiceStatus')({ state: 'down', message: 'Stopped. See /x/sidecar.log' });
    await settle();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      'Showing the last numbers. Stopped. See /x/sidecar.log',
    );
  });

  it('announces only runs the user started, and says how they ended', async () => {
    mounted.push(mount(App, { target }));
    await settle();
    const onState = listener('onState');
    const live = () => target.querySelector('[role="status"][aria-live="polite"]')?.textContent;
    onState({ ...state, refreshing: true });
    await settle();
    onState({ ...state });
    await settle();
    expect(live()).toBe('');

    const failing = [
      {
        key: 'codex' as const,
        label: 'Codex',
        refreshing: false,
        quotaError: { kind: 'network' as const, message: 'offline' },
      },
    ];
    click('[aria-label="Refresh"]');
    onState({ ...state, refreshing: true });
    await settle();
    expect(live()).toBe('Updating…');
    onState({ ...state, providers: failing, usageError: 'unreadable' });
    await settle();
    expect(live()).toBe('Refresh finished, usage could not be read, Codex limits unavailable');
    click('[aria-label="Refresh"]');
    onState({ ...state, refreshing: true });
    await settle();
    onState({ ...state });
    await settle();
    expect(live()).toBe('Usage updated');

    click('[aria-label="Sync this machine"]');
    onState({ ...state, syncing: true });
    await settle();
    expect(live()).toBe('Syncing…');
    onState({ ...state, syncResult: { ok: false, message: 'no remote' } });
    await settle();
    expect(live()).toBe('Sync failed: no remote');
    click('[aria-label="Sync this machine"]');
    onState({ ...state, syncing: true });
    await settle();
    onState({ ...state, syncResult: { ok: true, message: 'Synced 2 files' } });
    await settle();
    expect(live()).toBe('Synced 2 files');
    expect(target.querySelector('.foot')?.textContent).toContain('Synced 2 files');
  });

  it('moves focus and resets scroll between screens, and handles Escape', async () => {
    mounted.push(mount(App, { target }));
    await settle();
    const scroller = target.querySelector<HTMLElement>('.scroll');
    if (!scroller) throw new Error('missing scroll area');
    scroller.scrollTop = 300;
    click('[aria-label="Settings"]');
    await settle();
    expect(document.activeElement).toBe(target.querySelector('h1'));
    expect(scroller.scrollTop).toBe(0);

    const select = target.querySelector('#set-theme');
    if (!select) throw new Error('missing select');
    escape(select); // Could be closing the select's list.
    await settle();
    expect(target.querySelector('h1')).not.toBeNull();
    expect(mocks.api.hideWindow).not.toHaveBeenCalled();

    escape();
    await settle();
    expect(target.querySelector('h1')).toBeNull();
    expect(document.activeElement).toBe(target.querySelector('[aria-label="Settings"]'));
    expect(mocks.api.hideWindow).not.toHaveBeenCalled();

    escape();
    expect(mocks.api.hideWindow).toHaveBeenCalledTimes(1);
    listener('onSettings')({ ...DEFAULT_SETTINGS, keepOpen: true });
    await settle();
    escape();
    expect(mocks.api.hideWindow).toHaveBeenCalledTimes(1);
  });

  it('cues content below the fold until it is scrolled to, and shows a save error', async () => {
    mounted.push(mount(App, { target }));
    await settle();
    const scroller = target.querySelector<HTMLElement>('.scroll');
    if (!scroller) throw new Error('missing scroll area');
    Object.defineProperty(scroller, 'scrollHeight', { value: 900 });
    Object.defineProperty(scroller, 'clientHeight', { value: 600 });
    expect(target.querySelector('.scroll-more')).toBeNull();
    scroller.dispatchEvent(new Event('scroll'));
    await settle();
    expect(target.querySelector('.scroll-more')).not.toBeNull();
    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event('scroll'));
    await settle();
    expect(target.querySelector('.scroll-more')).toBeNull();

    mocks.api.saveSettings.mockRejectedValueOnce(new Error('disk full'));
    click('[aria-label="Compact view"]');
    await settle();
    expect(target.textContent).toContain('Could not save settings: disk full');
    expect(scroller.scrollTop).toBe(0);
  });

  it('tells a down service apart: banner, old limits, no commands, reload on recovery', async () => {
    const now = Date.now();
    mocks.api.serviceStatus.mockResolvedValue({
      state: 'down',
      message: 'Stopped. See /x/sidecar.log',
    });
    mocks.api.getState.mockResolvedValue({
      ...state,
      providers: [
        {
          key: 'codex',
          label: 'Codex',
          refreshing: false,
          quota: {
            provider: 'codex',
            fetchedAt: new Date(now).toISOString(),
            values: [],
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
        },
      ],
    });
    const first = mount(App, { target });
    await settle();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      'Showing the last numbers. Stopped. See /x/sidecar.log',
    );
    expect(target.querySelector('.foot')?.textContent).toContain('Background service stopped');
    expect(target.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.disabled).toBe(true);
    expect(target.querySelector('.tick')).toBeNull();
    expect(target.querySelector('[role="meter"]')?.getAttribute('aria-valuetext')).toBe(
      '40%, cached',
    );
    const onStatus = listener('onServiceStatus');
    onStatus({ state: 'running', message: null });
    await settle();
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.querySelector('.tick')).not.toBeNull();
    expect(mocks.api.getState).toHaveBeenCalledTimes(1);
    await unmount(first);

    // Nothing loaded while it was down: the load banner is the one way out, and recovery retries it.
    mocks.api.getState.mockReset().mockRejectedValueOnce(new Error('The service stopped'));
    mocks.api.getState.mockResolvedValue(state);
    mocks.api.serviceStatus.mockResolvedValue({ state: 'down', message: 'The service stopped' });
    mocks.api.onServiceStatus.mockClear();
    mounted.push(mount(App, { target }));
    await settle();
    expect(target.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(target.textContent).toContain('Could not load dashboard: The service stopped');
    listener('onServiceStatus')({ state: 'running', message: null });
    await settle();
    expect(target.textContent).not.toContain('Could not load dashboard');
    expect(target.querySelector('.summary')).not.toBeNull();
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
        view: 'providers',
        onPeriod: period,
        onView: vi.fn(),
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
    providers: [
      { key: 'claude_code', label: 'Claude Code', refreshing: false },
      { key: 'cursor', label: 'Cursor', refreshing: false },
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
  // By cost; Codex is turned off, so desk's $9 of it does not count.
  expect(names).toEqual(['desk', 'laptop This machine', 'Cursor account', 'idle']);
  expect([...target.querySelectorAll('.m-percent')].map((cell) => cell.textContent)).toEqual([
    '75%',
    '25%',
  ]);
  expect(target.textContent).toContain('Live · not synced yet');
  expect(target.textContent).toContain('Synced 10d 0h ago · stale');
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
    expect(target.textContent).toContain('npx aitrack init');
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
      providers: [
        {
          key: 'cursor' as const,
          label: 'Cursor',
          refreshing: false,
          usage: usage(EMPTY_PERIOD, []),
        },
      ],
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
  const none = mount(Dashboard, {
    target,
    props: {
      ...props,
      period: 'month' as const,
      appState: {
        ...props.appState,
        projects,
        providers: [{ ...props.appState.providers[0], key: 'codex' as const, label: 'Codex' }],
      },
    },
  });
  await settle();
  expect(target.textContent).toContain('No project usage in the last 30 days.');
  expect(target.textContent).not.toContain('from the next sync');
  await unmount(none);
  const empty = mount(Dashboard, {
    target,
    props: { ...props, appState: { ...props.appState, projects: undefined } },
  });
  await settle();
  expect(target.textContent).toContain('from the next sync or refresh onward');
  await unmount(empty);
  // Cursor is off, so there is nothing to explain about it.
  const noCursor = mount(Dashboard, {
    target,
    props: {
      ...props,
      appState: {
        ...props.appState,
        providers: [{ ...props.appState.providers[0], key: 'codex' as const, label: 'Codex' }],
      },
    },
  });
  await settle();
  expect(target.textContent).not.toContain('Cursor is not attributed');
  await unmount(noCursor);
});

it('charts cost history by provider and switches range and grouping', async () => {
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
  expect(target.textContent).toContain('May 11');
  expect(target.querySelector('.h-chart')?.getAttribute('aria-label')).toContain(
    'peak $20.00 on May 11',
  );
  expect(target.querySelector('.h-swatch--claude_code')).not.toBeNull();
  expect(target.querySelector('.h-chart title')?.textContent).toContain('(Claude Code $20.00)');

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
    props: {
      ...props,
      appState: {
        ...appState,
        providers: [{ ...appState.providers[1], usage: usage(spent(5, 0, 'x'), []) }],
      },
    },
  });
  await settle();
  expect(target.textContent).toContain('No priced usage');
  await unmount(empty);
  const offToHistory = mount(Dashboard, {
    target,
    props: { ...props, appState: { ...appState, providers: [] } },
  });
  await settle();
  expect(target.textContent).toContain('No providers are turned on. Choose some in Settings.');
  expect(target.querySelector('.history')).toBeNull();
  await unmount(offToHistory);
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
        view: 'providers',
        onPeriod: () => {},
        onView: () => {},
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

function sessionProvider(key: 'claude_code' | 'codex', label: string, usedPercent: number) {
  return {
    key,
    label,
    refreshing: false,
    usage: usage(EMPTY_PERIOD, []),
    quota: {
      provider: key,
      fetchedAt: new Date().toISOString(),
      values: [],
      windows: [
        {
          id: 'session',
          label: 'Session',
          usedPercent,
          format: 'percent' as const,
          periodSeconds: 18_000,
          resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        {
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 1,
          format: 'percent' as const,
          periodSeconds: 604_800,
        },
      ],
    },
  };
}

function mountCompact(
  appState: AppState,
  settings: Settings,
  onPatch = vi.fn(),
  serviceDown = false,
): void {
  mounted.push(
    mount(CompactLimit, {
      target,
      props: { appState, settings, now: Date.now(), serviceDown, onPatch },
    }),
  );
}

it('compact view shows one limit per provider in full-view order, session first, with plan and toggles', async () => {
  const patch = vi.fn<(value: Partial<Settings>) => void>();
  const claude = sessionProvider('claude_code', 'Claude Code', 20);
  const weeklyOnly = claude.quota.windows.filter(({ id }) => id === 'weekly');
  const noSession = { ...claude, quota: { ...claude.quota, plan: 'Max', windows: weeklyOnly } };
  const codex = sessionProvider('codex', 'Codex', 70);
  const cursor = { ...codex, key: 'cursor' as const, label: 'Cursor', quota: undefined };
  const providers = [noSession, codex, cursor];
  mountCompact({ ...state, providers }, DEFAULT_SETTINGS, patch);
  await settle();
  const meters = [...target.querySelectorAll('[role="meter"]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  expect(meters).toEqual(['Weekly used', 'Session used']); // Weekly stands in where there is no session limit.
  const headers = [...target.querySelectorAll('.p-name')].map((node) => node.textContent);
  expect(headers).toEqual(['Claude Code', 'Codex', 'Cursor']);
  expect(target.textContent).toContain('No limits yet.');
  expect(target.textContent).toContain('Max');
  click('[title="Show used or left"]');
  click('[title="Show time or countdown"]');
  expect(patch).toHaveBeenCalledWith({ display: 'left' });
  expect(patch).toHaveBeenCalledWith({ resetDisplay: 'relative' });
});

it.each([
  ['the service is down', true, undefined, undefined],
  [
    'the provider failed, and says why',
    false,
    { kind: 'network' as const, message: 'offline' },
    'Could not reach the service',
  ],
])('compact view marks limits cached while %s', async (_, serviceDown, quotaError, problem) => {
  const provider = { ...sessionProvider('claude_code', 'Claude Code', 20), quotaError };
  mountCompact({ ...state, providers: [provider] }, DEFAULT_SETTINGS, vi.fn(), serviceDown);
  await settle();
  expect(target.querySelector('[role="meter"]')?.getAttribute('aria-valuetext')).toContain(
    'cached',
  );
  expect(target.querySelector('.state')?.textContent).toBe(problem);
});

it('compact view explains an empty view', async () => {
  mountCompact({ ...state, providers: [] }, DEFAULT_SETTINGS);
  await settle();
  expect(target.textContent).toContain('No providers are turned on.');
  expect(target.querySelector('[role="meter"]')).toBeNull();
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
  const toggle = target.querySelector<HTMLInputElement>('[aria-label="Track Cursor"]');
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
  expect(meter?.getAttribute('aria-valuetext')).toBe('60% left, on pace');
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
  const last = target.querySelector('[aria-label="Move Cursor down"]');
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
  // A sign-in problem: the text says what to do, and the website cannot fix it.
  expect(target.textContent).toContain('signed out');
  expect(target.querySelector('.state button')?.textContent).toBe('Retry');
  expect(target.textContent).not.toContain('Open dashboard');
  listener('onState')({
    ...state,
    providers: [
      {
        key: 'cursor',
        label: 'Cursor',
        refreshing: false,
        retryAt: Date.now() + 3_600_000,
        quotaError: { kind: 'rateLimited', message: 'HTTP 429' },
      },
    ],
  });
  await settle();
  mocks.api.openDashboard.mockRejectedValueOnce(new Error('opener denied'));
  expect(target.querySelector('.state button')?.textContent).toBe('Open dashboard');
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
  onUpdate(null);
  await settle();
  expect(target.textContent).not.toContain('3.1.0');
});

it('reports the unrounded height of the content and footer', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return {
      height: this.className === 'foot' ? 41.5 : 600.25,
    } as DOMRect;
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

it('does not state $0.00 as fact before usage is known, and guides an empty first run', async () => {
  const provider = { key: 'codex' as const, label: 'Codex', refreshing: false };
  const props = {
    settings: DEFAULT_SETTINGS,
    now: Date.now(),
    period: 'today' as const,
    view: 'providers' as const,
    onPeriod: vi.fn(),
    onView: vi.fn(),
    onPatch: vi.fn(),
    ...handlers(),
  };
  const show = async (
    appState: AppState,
    view: 'providers' | 'history' | 'projects' = 'providers',
  ) => {
    const dashboard = mount(Dashboard, { target, props: { ...props, view, appState } });
    await settle();
    const text = target.textContent;
    const amount = target.querySelector('.amount')?.textContent.trim();
    await unmount(dashboard);
    return { text, amount };
  };
  const base = { ...state, providers: [provider] };
  for (const appState of [base, { ...base, refreshing: true }]) {
    const { text, amount } = await show(appState);
    expect(amount).toBe('—');
    expect(text).toContain('Reading usage…');
    expect(text).not.toContain('$0.00');
  }
  const failed = await show({ ...base, usageError: 'disk gone' });
  expect(failed.amount).toBe('—');
  expect(failed.text).toContain('Usage could not be read');
  expect(failed.text).toContain('disk gone');
  const empty = await show({
    ...base,
    usageEmpty: true,
    usageUpdatedAt: new Date().toISOString(),
  });
  expect(empty.amount).toBe('—');
  expect(empty.text).toContain('No usage found yet');
  expect(empty.text).toContain('Use Codex, then refresh');
  expect(empty.text).toContain('npx aitrack init');
  for (const view of ['history', 'projects'] as const) {
    const tab = await show({ ...base, refreshing: true }, view);
    expect(tab.text).toContain('Reading usage…');
    expect(tab.text).not.toContain('No priced usage');
    expect(tab.text).not.toContain('No project usage');
  }
  const zero = await show({
    ...base,
    providers: [{ ...provider, usage: usage(EMPTY_PERIOD, []) }],
  });
  expect(zero.amount).toBe('$0.00');
});

it('mutes a limit whose reset has passed and stops projecting from cached numbers', async () => {
  const now = Date.now();
  const window = {
    id: 'session',
    label: 'Session',
    usedPercent: 92,
    periodSeconds: 18_000,
    format: 'percent' as const,
  };
  const props = {
    settings: DEFAULT_SETTINGS,
    now,
    onToggleUsage: () => {},
    onToggleReset: () => {},
  };
  const past = mount(LimitMeter, {
    target,
    props: {
      ...props,
      window: { ...window, resetsAt: new Date(now - 9 * 3600_000).toISOString() },
    },
  });
  await settle();
  expect(target.textContent).toContain('Reset passed, waiting for new data');
  expect(target.textContent).not.toContain('Resets soon');
  expect(target.querySelector('.limit')?.className).toContain('past');
  expect(target.querySelector('.limit')?.className).toContain('tone-calm');
  expect(target.querySelector('[role="meter"]')?.getAttribute('aria-valuetext')).toBe(
    '92%, reset passed',
  );
  await unmount(past);
  const ahead = { ...window, usedPercent: 50, resetsAt: new Date(now + 3600_000).toISOString() };
  const live = mount(LimitMeter, { target, props: { ...props, window: ahead } });
  await settle();
  expect(target.querySelector('.tick')).not.toBeNull();
  expect(target.querySelector('.l-pace')?.textContent).toBe('On pace');
  await unmount(live);
  const cached = mount(LimitMeter, { target, props: { ...props, window: ahead, stale: true } });
  await settle();
  expect(target.querySelector('.tick')).toBeNull();
  expect(target.querySelector('.l-pace')).toBeNull();
  await unmount(cached);
});

it('marks days and machines that are not fully priced, with names readable in full', async () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const daily = [
    { date: '2026-05-30', costUSD: 10 },
    { date: '2026-05-31', costUSD: 2 },
    { date: '2026-06-01', costUSD: 0, hasUnpricedTokens: true },
  ];
  const appState: AppState = {
    ...state,
    providers: [
      {
        key: 'claude_code',
        label: 'Claude Code',
        refreshing: false,
        usage: usage(spent(9, 0, 'long-model'), daily),
      },
    ],
    machines: [
      {
        name: 'a-long-machine-name',
        timezone: 'UTC',
        lastUpdated: '',
        current: true,
        providers: { claude_code: usage(spent(9, 1, 'long-model'), daily) },
      },
    ],
  };
  const props = {
    appState,
    settings: DEFAULT_SETTINGS,
    now,
    period: 'today' as const,
    onPeriod: vi.fn(),
    onView: vi.fn(),
    onPatch: vi.fn(),
    ...handlers(),
  };
  const machines = mount(Dashboard, { target, props: { ...props, view: 'machines' } });
  await settle();
  const cells = [...target.querySelectorAll<HTMLElement>('.m-cell')];
  // The library's thresholds: 20% of the peak is level 2.
  expect(cells.map((cell) => cell.dataset.level)).toEqual(['4', '2', '1']);
  expect(cells[2]?.title).toBe('Jun 1 · Not priced');
  expect(target.querySelector('.m-strip')?.getAttribute('aria-label')).toContain(
    'peak $10.00 on May 30',
  );
  expect(target.querySelector('.m-name-text')?.getAttribute('title')).toBe('a-long-machine-name');
  click('.m-head');
  await settle();
  expect(target.querySelector('.d-model span')?.getAttribute('title')).toBe('long-model');
  await unmount(machines);
  const history = mount(Dashboard, { target, props: { ...props, view: 'history' } });
  await settle();
  expect(target.querySelector('.h-stats')?.textContent).toContain('Total (partial)$12.00');
  expect(target.querySelector('.history .summary-provider-value')?.textContent).toContain(
    '(partial)',
  );
  await unmount(history);
  // Only unpriced days for one provider: it stays listed, with no price and no fake zero.
  const tokensOnly = mount(Dashboard, {
    target,
    props: {
      ...props,
      view: 'history',
      appState: {
        ...appState,
        providers: [
          ...appState.providers,
          {
            key: 'cursor',
            label: 'Cursor',
            refreshing: false,
            usage: usage(spent(9, 0, 'auto'), [
              { date: '2026-06-01', costUSD: 0, hasUnpricedTokens: true },
            ]),
          },
        ],
      },
    },
  });
  await settle();
  const chips = [...target.querySelectorAll('.history .summary-provider-value')];
  expect(chips.map((chip) => chip.textContent)).toEqual(['$12.00 (partial)', '— (partial)']);
  [...target.querySelectorAll<HTMLButtonElement>('[aria-label="Group by"] button')].at(1)?.click();
  await settle();
  expect(target.querySelector('.h-stats')?.textContent).toContain('Busiest week');
  expect(target.querySelector('.h-chart title')?.textContent).toContain('Week of');
  await unmount(tokensOnly);
});

it('keeps the history range and grouping across a visit to Settings', async () => {
  const daily = Array.from({ length: 40 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 4, 1 + index)).toISOString().slice(0, 10),
    costUSD: 1,
  }));
  mocks.api.getState.mockResolvedValue({
    ...state,
    providers: [
      { key: 'codex', label: 'Codex', refreshing: false, usage: usage(spent(9, 1, 'x'), daily) },
    ],
  });
  mounted.push(mount(App, { target }));
  await settle();
  click('#tab-history');
  await settle();
  const pressed = () =>
    target.querySelector('[aria-label="Range"] [aria-pressed="true"]')?.textContent;
  target.querySelectorAll<HTMLButtonElement>('[aria-label="Range"] button')[1]?.click();
  await settle();
  expect(pressed()).toBe('90 days');
  click('[aria-label="Settings"]');
  await settle();
  click('[aria-label="Back"]');
  await settle();
  expect(pressed()).toBe('90 days');
  expect(target.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(
    'tab-history',
  );
});
