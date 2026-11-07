import type { MachineFile } from 'aitrack-lib/data/types';
import type { QuotaResult } from 'aitrack-lib/quota/types';
import { describe, expect, it, vi } from 'vitest';

import type { AppState, QuotaProviderKey } from '../../shared/types.js';
import { EMPTY_PERIOD } from '../../shared/types.js';
import type { Alert } from '../alerts.js';
import {
  CACHE_FORMAT,
  FAILURE_BACKOFF_MS,
  loadCachedState,
  PULL_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  QuotaService,
  type CachedState,
  type ServiceDeps,
} from '../service.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import type { UsageSummary } from '../usage.js';

const START = Date.parse('2026-06-01T12:00:00.000Z');
// Only passed through, never read.
const MACHINE = { hostname: 'host' } as MachineFile;
const SUMMARY: UsageSummary = {
  providers: {},
  machines: ['desk', 'laptop'].map((name) => ({
    name,
    timezone: 'UTC',
    lastUpdated: '',
    current: name === 'desk',
    providers: {},
  })),
};

function ok(provider: QuotaProviderKey, usedPercent = 10, now = START): QuotaResult {
  return {
    ok: true,
    snapshot: {
      provider,
      windows: [
        {
          id: 'session',
          label: 'Session',
          usedPercent,
          periodSeconds: 18_000,
          resetsAt: new Date(now + 3_600_000).toISOString(),
          format: 'percent',
        },
      ],
      values: [],
      fetchedAt: new Date(now).toISOString(),
    },
  };
}

function harness(
  results: Partial<Record<QuotaProviderKey, () => QuotaResult>> = {},
  overrides: Partial<ServiceDeps> = {},
  cached?: CachedState,
) {
  let now = START;
  const calls: QuotaProviderKey[] = [];
  const pulls: boolean[] = [];
  const read: QuotaProviderKey[][] = [];
  const reused: Array<MachineFile | undefined> = [];
  const states: AppState[] = [];
  const alerts: Alert[] = [];
  let persisted = 0;
  let usageFails = false;
  let syncFails = false;
  const deps: ServiceDeps = {
    fetchQuota: (provider) => {
      calls.push(provider);
      return Promise.resolve(results[provider]?.() ?? ok(provider, 10, now));
    },
    loadUsage: ({ providers, pull, localMachine }) => {
      read.push(providers);
      pulls.push(pull);
      reused.push(localMachine);
      if (usageFails) return Promise.reject(new Error('disk on fire'));
      return Promise.resolve({ summary: SUMMARY, warning: undefined });
    },
    now: () => now,
    onState: (state) => {
      states.push(state);
    },
    onAlert: (alert) => {
      alerts.push(alert);
    },
    persist: () => {
      persisted += 1;
    },
    sync: () =>
      syncFails
        ? Promise.reject(new Error('remote: permission denied'))
        : Promise.resolve({ message: 'Done! Pushed data/host.json (3 days)', machine: MACHINE }),
  };
  const service = new QuotaService({ ...deps, ...overrides }, DEFAULT_SETTINGS, cached);
  return {
    service,
    calls,
    pulls,
    read,
    reused,
    states,
    alerts,
    persisted: () => persisted,
    advance: (ms: number) => {
      now += ms;
    },
    failUsage: () => {
      usageFails = true;
    },
    failSync: () => {
      syncFails = true;
    },
  };
}

function harnessDeps(): ServiceDeps {
  return {
    fetchQuota: () => Promise.reject(new Error('unused')),
    loadUsage: () => Promise.reject(new Error('unused')),
    now: () => START,
    onState: () => {},
    onAlert: () => {},
    persist: () => {},
    sync: () => Promise.reject(new Error('unused')),
  };
}

describe('QuotaService', () => {
  it('refreshes every enabled provider and the usage once', async () => {
    const h = harness();
    const run = h.service.refresh();
    await Promise.resolve();
    // Every provider and the usage start in one tick, which pushes one state, not four.
    expect(h.states).toHaveLength(1);
    await run;
    expect(h.calls).toEqual(['claude_code', 'codex', 'cursor']);
    expect(h.pulls).toEqual([true]);
    const state = h.service.state();
    expect(state.providers.map((provider) => provider.quota?.provider)).toEqual([
      'claude_code',
      'codex',
      'cursor',
    ]);
    expect(state.refreshing).toBe(false);
    expect(state.machines).toHaveLength(2);
    expect(h.persisted()).toBe(1);
    expect(h.states.some((value) => value.refreshing)).toBe(true);
  });

  it('shows finished usage without waiting for a slow quota', async () => {
    const h = harness({}, { fetchQuota: () => new Promise(() => {}) });
    void h.service.refresh();
    await vi.waitFor(() => {
      expect(h.states.at(-1)?.refreshing).toBe(true);
      expect(h.states.at(-1)?.machines).toHaveLength(2);
    });
    expect(h.states.at(-1)?.usageUpdatedAt).toBe(new Date(START).toISOString());
  });

  it('waits for the schedule unless forced', async () => {
    const h = harness();
    await h.service.refresh();
    await h.service.refresh();
    expect(h.calls).toHaveLength(3);
    h.advance(REFRESH_INTERVAL_MS);
    await h.service.refresh();
    expect(h.calls).toHaveLength(6);
    expect(h.pulls).toEqual([true, false]);
    await h.service.refresh(true);
    expect(h.calls).toHaveLength(9);
    expect(h.pulls).toEqual([true, false, true]);
    h.advance(PULL_INTERVAL_MS);
    await h.service.refresh();
    expect(h.pulls.at(-1)).toBe(true);
  });

  it('backs off after failures and honours retry-after even when forced', async () => {
    const h = harness({
      claude_code: () => ({ ok: false, error: { kind: 'auth', message: 'token rejected' } }),
      codex: () => ({
        ok: false,
        error: { kind: 'rateLimited', message: 'slow down', retryAfterSeconds: 300 },
      }),
      cursor: () => ({ ok: false, error: { kind: 'noCredentials', message: 'sign in' } }),
    });
    await h.service.refresh();
    const state = h.service.state();
    expect(state.providers[1]?.quotaError?.kind).toBe('rateLimited');
    expect(state.providers[1]?.retryAt).toBe(START + 300_000);
    expect(state.providers[2]?.quota).toBeUndefined();
    h.calls.length = 0;
    await h.service.refresh(true);
    expect(h.calls).toEqual(['claude_code', 'cursor']);
    h.calls.length = 0;
    h.advance(FAILURE_BACKOFF_MS);
    await h.service.refresh();
    expect(h.calls).toEqual(['cursor']);
  });

  it('lets a click retry a bare 429, which only our own backoff holds back', async () => {
    const h = harness({
      codex: () => ({ ok: false, error: { kind: 'rateLimited', message: 'slow down' } }),
    });
    await h.service.refresh();
    expect(h.service.state().providers[1]?.retryAt).toBeUndefined();
    h.calls.length = 0;
    await h.service.refresh();
    expect(h.calls).toEqual([]);
    await h.service.refresh(true);
    expect(h.calls).toContain('codex');
  });

  it('alerts once per reset and only when enabled', async () => {
    const h = harness({ claude_code: () => ok('claude_code', 95, START) });
    await h.service.refresh();
    expect(h.alerts.map((alert) => alert.title)).toEqual(['Claude Code session almost used up']);
    await h.service.refresh(true);
    expect(h.alerts).toHaveLength(1);

    const quiet = harness({ claude_code: () => ok('claude_code', 95, START) });
    quiet.service.setSettings({ ...DEFAULT_SETTINGS, notifications: false });
    await quiet.service.refresh();
    expect(quiet.alerts).toEqual([]);
  });

  it('alerts for the next window on the first refresh after the last one reset', async () => {
    let now = START;
    const h = harness({ claude_code: () => ok('claude_code', 95, now) });
    await h.service.refresh();
    const pastResetAndGrace = 3_600_000 + 6 * 60_000;
    now += pastResetAndGrace;
    h.advance(pastResetAndGrace);
    await h.service.refresh();
    expect(h.alerts).toHaveLength(2);
  });

  it('reports usage failures, skips disabled providers and reloads usage only when the enabled set changes', async () => {
    const h = harness();
    h.failUsage();
    h.service.setSettings({
      ...DEFAULT_SETTINGS,
      pullSyncedData: false,
      providers: DEFAULT_SETTINGS.providers.map((provider) => ({
        ...provider,
        enabled: provider.key === 'claude_code',
      })),
    });
    await h.service.refresh();
    expect(h.calls).toEqual(['claude_code']);
    expect(h.pulls).toEqual([false]);
    expect(h.service.state()).toMatchObject({
      usageError: 'disk on fire',
      providers: [{ key: 'claude_code' }],
    });
    expect(h.read).toEqual([['claude_code']]);

    h.service.setSettings({ ...DEFAULT_SETTINGS, pullSyncedData: false });
    await h.service.refresh(); // Still inside the failure backoff.
    expect(h.read).toEqual([['claude_code'], ['claude_code', 'codex', 'cursor']]);

    h.service.setSettings({
      ...DEFAULT_SETTINGS,
      pullSyncedData: false,
      providers: DEFAULT_SETTINGS.providers.toReversed(),
    });
    await h.service.refresh();
    expect(h.read).toHaveLength(2);
  });

  it('keeps a retry-after across restarts', async () => {
    let saved: CachedState | undefined;
    const h = harness(
      {
        claude_code: () => ({
          ok: false,
          error: { kind: 'rateLimited', message: 'slow', retryAfterSeconds: 600 },
        }),
      },
      {
        persist: (cache) => {
          saved = structuredClone(cache);
        },
      },
    );
    await h.service.refresh();
    expect(saved?.rateLimitedUntil).toEqual({ claude_code: START + 600_000 });

    const restarted = harness({}, {}, saved);
    expect(restarted.service.state().providers[0]?.quotaError?.kind).toBe('rateLimited');
    await restarted.service.refresh(true);
    expect(restarted.calls).toEqual(['codex', 'cursor']);
  });

  it('syncs, then reloads usage from what the sync read, without pulling again', async () => {
    const h = harness();
    await h.service.sync();
    expect(h.states.some((value) => value.syncing)).toBe(true);
    expect(h.service.state()).toMatchObject({
      syncing: false,
      syncResult: { ok: true, message: 'Done! Pushed data/host.json (3 days)' },
    });
    expect(h.pulls).toEqual([false]);
    expect(h.reused).toEqual([MACHINE]);

    h.advance(REFRESH_INTERVAL_MS);
    const refreshing = h.service.refresh();
    const queued = h.service.sync();
    await Promise.all([refreshing, queued]);
    expect(h.pulls).toEqual([false, false, false]); // The queued sync ran and reloaded after it.
    expect(h.reused).toEqual([MACHINE, undefined, MACHINE]);

    h.failSync();
    await h.service.sync();
    expect(h.service.state().syncResult).toEqual({
      ok: false,
      message: 'remote: permission denied',
    });
  });

  it('keeps sync exclusive through the prior refresh and the usage reload', async () => {
    const summary = SUMMARY;
    let finishEarlier: (() => void) | undefined;
    let finishReload: (() => void) | undefined;
    const earlier = new Promise<void>((resolve) => {
      finishEarlier = resolve;
    });
    const reloaded = new Promise<void>((resolve) => {
      finishReload = resolve;
    });
    const loadUsage = vi
      .fn<ServiceDeps['loadUsage']>()
      .mockImplementationOnce(async () => {
        await earlier;
        return { summary };
      })
      .mockImplementationOnce(async () => {
        await reloaded;
        return { summary };
      });
    const sync = vi
      .fn<ServiceDeps['sync']>()
      .mockResolvedValue({ message: 'Done', machine: MACHINE });
    const { service } = harness({}, { loadUsage, sync });
    const refreshing = service.refresh();
    const syncing = service.sync();
    await Promise.resolve();
    expect(service.state().syncing).toBe(true);
    await service.sync();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(service.state().syncing).toBe(true);

    finishEarlier?.();
    await refreshing;
    await vi.waitFor(() => {
      expect(loadUsage).toHaveBeenCalledTimes(2);
    });
    await service.sync();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(service.state().syncing).toBe(true);
    expect(loadUsage).toHaveBeenLastCalledWith({
      providers: ['claude_code', 'codex', 'cursor'],
      pull: false,
      refreshLive: false,
      localMachine: MACHINE,
    });
    finishReload?.();
    await syncing;
    expect(service.state()).toMatchObject({ syncing: false, refreshing: false });
  });

  it('drops malformed parts of a hand-edited cache', () => {
    const snapshot = ok('codex');
    expect(
      loadCachedState({
        format: CACHE_FORMAT,
        quotas: { claude_code: {}, codex: snapshot.ok ? snapshot.snapshot : undefined, x: {} },
        usage: {
          providers: { claude_code: { today: {} } },
          machines: [
            { name: 'old' },
            { name: 'work', timezone: 'UTC', lastUpdated: '', current: false, providers: [] },
          ],
          account: { cursor: { today: {} } },
        },
        fired: { a: '2026-06-01T12:00:00.000Z', b: 123 },
        rateLimitedUntil: { cursor: 'soon', codex: START },
      }),
    ).toEqual({
      quotas: { codex: snapshot.ok ? snapshot.snapshot : undefined },
      usage: {
        providers: {},
        machines: [
          { name: 'work', timezone: 'UTC', lastUpdated: '', current: false, providers: {} },
        ],
        account: {},
      },
      fired: { a: '2026-06-01T12:00:00.000Z' },
      rateLimitedUntil: { codex: START },
    });
  });

  it('keeps cached project usage only when every period is well formed', () => {
    const entry = {
      project: 'acme/widget',
      tokens: 1,
      costUSD: 0,
      hasCost: false,
      providers: [{ key: 'codex', label: 'Codex', tokens: 1, costUSD: 0, hasCost: false }],
    };
    const projects = { today: [entry], last7Days: [], last30Days: [], allTime: [] };
    expect(loadProjects(projects)?.projects).toEqual(projects);
    expect(
      loadProjects({ ...projects, today: [{ ...entry, providers: [{ key: 1 }] }] })?.projects,
    ).toBe(undefined);
    expect(loadProjects({ ...projects, allTime: undefined })?.projects).toBeUndefined();
    expect(loadProjects('nope')?.projects).toBeUndefined();
  });

  it('reads only the current cache format', () => {
    const cache = { updatedAt: '2026-06-01T12:00:00.000Z', fired: { alert: 'soon' } };
    expect(loadCachedState({ ...cache, format: CACHE_FORMAT })).toMatchObject(cache);
    const empty = { quotas: {}, usage: undefined, fired: {}, rateLimitedUntil: {} };
    for (const input of [{ ...cache, format: 1 }, { ...cache, format: 3 }, 'garbage']) {
      expect(loadCachedState(input)).toEqual(empty);
    }
  });

  it.each([
    { provider: 'claude_code' },
    { plan: {} },
    { fetchedAt: 'soon' },
    { usedValue: null },
    { limitValue: '50' },
  ])('drops malformed quota snapshot fields: %j', ({ usedValue, limitValue, ...patch }) => {
    const result = ok('codex');
    if (!result.ok) throw new Error('expected quota');
    const snapshot = {
      ...result.snapshot,
      ...patch,
      windows: [{ ...result.snapshot.windows[0], format: 'dollars', usedValue, limitValue }],
    };
    expect(loadCachedState({ format: CACHE_FORMAT, quotas: { codex: snapshot } }).quotas).toEqual(
      {},
    );
  });

  it('drops a cached provider with a missing period and keeps the unpriced mark on its days', () => {
    const period = { tokens: 10, costUSD: 1, hasCost: true, models: [] };
    const usage = {
      today: period,
      yesterday: EMPTY_PERIOD,
      last7Days: EMPTY_PERIOD,
      last30Days: EMPTY_PERIOD,
      allTime: period,
      daily: [
        { date: '2026-06-01', costUSD: 1, hasUnpricedTokens: true },
        { date: '2026-06-02', costUSD: 0 },
      ],
    };
    const { allTime: _allTime, ...withoutAllTime } = usage;
    expect(
      loadCachedState({
        format: CACHE_FORMAT,
        usage: { providers: { claude_code: usage, codex: withoutAllTime } },
      }).usage?.providers,
    ).toEqual({ claude_code: usage });
  });

  it('shows the cached machines before any load', () => {
    const cached = { quotas: {}, fired: {}, usage: SUMMARY };
    expect(new QuotaService(harnessDeps(), DEFAULT_SETTINGS, cached).state().machines).toHaveLength(
      2,
    );
  });

  it('dates the limits by their oldest fetch, however fresh the usage is', async () => {
    let fail = false;
    const h = harness({
      codex: () =>
        fail ? { ok: false, error: { kind: 'network', message: 'offline' } } : ok('codex'),
    });
    expect(h.service.state().quotaUpdatedAt).toBeUndefined();
    await h.service.refresh();
    fail = true;
    h.advance(REFRESH_INTERVAL_MS);
    await h.service.refresh();
    const state = h.service.state();
    expect(state.usageUpdatedAt).toBe(new Date(START + REFRESH_INTERVAL_MS).toISOString());
    expect(state.quotaUpdatedAt).toBe(new Date(START).toISOString());
  });

  it('says usage is empty only after a load that worked and found nothing', async () => {
    const h = harness();
    expect(h.service.state().usageEmpty).toBeUndefined();
    await h.service.refresh();
    expect(h.service.state().usageEmpty).toBe(true);
    h.failUsage();
    await h.service.refresh(true);
    expect(h.service.state().usageEmpty).toBeUndefined();

    const period = { ...EMPTY_PERIOD, tokens: 1 };
    const found: UsageSummary['providers'] = {
      codex: {
        today: period,
        yesterday: EMPTY_PERIOD,
        last7Days: period,
        last30Days: period,
        allTime: period,
        daily: [],
      },
    };
    const used = new QuotaService(harnessDeps(), DEFAULT_SETTINGS, {
      quotas: {},
      fired: {},
      usage: { providers: found },
    });
    expect(used.state().usageEmpty).toBeUndefined();
  });

  it('does not call usage empty while the load for newly enabled providers runs', async () => {
    const finishLoad: Array<(result: { summary: UsageSummary }) => void> = [];
    const service = new QuotaService(
      {
        ...harnessDeps(),
        fetchQuota: (provider) => Promise.resolve(ok(provider, 10, START)),
        loadUsage: () =>
          new Promise((resolve) => {
            finishLoad.push(resolve);
          }),
      },
      {
        ...DEFAULT_SETTINGS,
        providers: DEFAULT_SETTINGS.providers.map((provider) => ({
          ...provider,
          enabled: provider.key === 'codex',
        })),
      },
      { quotas: {}, fired: {}, usage: { providers: {} } },
    );
    const run = service.refresh();
    await Promise.resolve();
    expect(service.state()).toMatchObject({ refreshing: true });
    expect(service.state().usageEmpty).toBeUndefined();

    finishLoad[0]?.({ summary: { providers: {} } });
    await run;
    expect(service.state().usageEmpty).toBe(true);
  });

  it('keeps pull failures through local reads, retries after one minute and restores the normal schedule', async () => {
    const pull = vi
      .fn()
      .mockResolvedValueOnce({ summary: SUMMARY, warning: 'pull failed' })
      .mockResolvedValue({ summary: SUMMARY });
    const h = harness({}, { loadUsage: pull });
    await h.service.refresh();
    expect(h.service.state().pullError).toBe('pull failed');
    h.failSync();
    await h.service.sync();
    expect(pull).toHaveBeenLastCalledWith(expect.objectContaining({ pull: false }));
    expect(h.service.state().pullError).toBe('pull failed');
    h.advance(FAILURE_BACKOFF_MS);
    await h.service.refresh();
    expect(pull).toHaveBeenLastCalledWith(expect.objectContaining({ pull: true }));
    expect(h.service.state().pullError).toBeUndefined();
    h.advance(FAILURE_BACKOFF_MS);
    await h.service.refresh();
    expect(pull).toHaveBeenCalledTimes(3);
    h.advance(PULL_INTERVAL_MS);
    await h.service.refresh();
    expect(pull).toHaveBeenLastCalledWith(expect.objectContaining({ pull: true }));
  });

  it('persists successful update times and keeps them unchanged when reads and quotas fail', async () => {
    const persist = vi.fn<(cache: CachedState) => void>();
    let fail = false;
    const h = harness(
      {
        claude_code: () =>
          fail ? { ok: false, error: { kind: 'network', message: 'offline' } } : ok('claude_code'),
      },
      { persist },
    );
    await h.service.refresh();
    const initial = h.service.state();
    expect(initial.usageUpdatedAt).toBe(new Date(START).toISOString());
    h.advance(FAILURE_BACKOFF_MS);
    h.failUsage();
    fail = true;
    await h.service.refresh(true);
    expect(h.service.state().usageUpdatedAt).toBe(initial.usageUpdatedAt);
    expect(h.service.state().providers[0]?.quota?.fetchedAt).toBe(
      initial.providers[0]?.quota?.fetchedAt,
    );
    expect(h.service.state().providers[0]?.quotaError?.message).toBe('offline');
    const cached = persist.mock.calls.at(-1)?.[0];
    if (!cached) throw new Error('expected persisted cache');
    expect(cached.usageUpdatedAt).toBe(initial.usageUpdatedAt);
    const restarted = harness({}, {}, cached).service.state();
    expect(restarted.usageUpdatedAt).toBe(initial.usageUpdatedAt);
    expect(restarted.providers[0]?.quota?.provider).toBe('claude_code');
  });

  it('retains both warnings when a pull and the following local read fail', async () => {
    const loadUsage = vi
      .fn<ServiceDeps['loadUsage']>()
      .mockResolvedValueOnce({ error: 'local read failed', warning: 'pull failed' })
      .mockResolvedValue({ summary: { providers: {} } });
    const h = harness({}, { loadUsage });
    await h.service.refresh();
    expect(h.service.state()).toMatchObject({
      usageError: 'local read failed',
      pullError: 'pull failed',
    });
    expect(h.service.state().usageUpdatedAt).toBeUndefined();
    h.advance(FAILURE_BACKOFF_MS);
    await h.service.refresh();
    expect(loadUsage).toHaveBeenLastCalledWith(expect.objectContaining({ pull: true }));
    expect(h.service.state().pullError).toBeUndefined();
    expect(h.service.state().usageError).toBeUndefined();
  });
});

function loadProjects(value: unknown) {
  return loadCachedState({ format: CACHE_FORMAT, usage: { providers: {}, projects: value } }).usage;
}
