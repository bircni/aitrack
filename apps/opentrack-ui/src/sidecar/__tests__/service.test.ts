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

const START = Date.parse('2026-06-01T12:00:00.000Z');
// Only passed through, never read.
const MACHINE = { hostname: 'host' } as MachineFile;

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
      return Promise.resolve({ summary: { providers: {}, machineCount: 2 }, warning: undefined });
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
    expect(state).toMatchObject({ refreshing: false, machineCount: 2 });
    expect(h.persisted()).toBe(1);
    expect(h.states.some((value) => value.refreshing)).toBe(true);
  });

  it('shows finished usage without waiting for a slow quota', async () => {
    const h = harness({}, { fetchQuota: () => new Promise(() => {}) });
    void h.service.refresh();
    await vi.waitFor(() => {
      expect(h.states.at(-1)).toMatchObject({ machineCount: 2, refreshing: true });
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
    expect(state.providers[2]?.quota).toBeUndefined();
    h.calls.length = 0;
    await h.service.refresh(true);
    expect(h.calls).toEqual(['claude_code', 'cursor']);
    h.calls.length = 0;
    h.advance(FAILURE_BACKOFF_MS);
    await h.service.refresh();
    expect(h.calls).toEqual(['cursor']);
  });

  it('keeps the last quota when a refresh fails', async () => {
    let fail = false;
    const h = harness({
      claude_code: () =>
        fail ? { ok: false, error: { kind: 'network', message: 'offline' } } : ok('claude_code'),
    });
    await h.service.refresh();
    fail = true;
    h.advance(REFRESH_INTERVAL_MS);
    await h.service.refresh();
    const [claude] = h.service.state().providers;
    expect(claude?.quota).toBeDefined();
    expect(claude?.quotaError?.message).toBe('offline');
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
    const summary = { providers: {}, machineCount: 2 };
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

  it('starts from the cached state', () => {
    const cached = ok('codex');
    const { service } = harness(
      {},
      {},
      {
        quotas: { codex: cached.ok ? cached.snapshot : undefined },
        fired: {},
      },
    );
    expect(service.state().providers[1]?.quota?.provider).toBe('codex');
  });

  it('drops malformed parts of a hand-edited cache', () => {
    const snapshot = ok('codex');
    expect(
      loadCachedState({
        format: CACHE_FORMAT,
        quotas: { claude_code: {}, codex: snapshot.ok ? snapshot.snapshot : undefined, x: {} },
        usage: { providers: { claude_code: { today: {} } } },
        fired: { a: '2026-06-01T12:00:00.000Z', b: 123 },
        rateLimitedUntil: { cursor: 'soon', codex: START },
      }),
    ).toEqual({
      quotas: { codex: snapshot.ok ? snapshot.snapshot : undefined },
      usage: { providers: {}, machineCount: 1 },
      fired: { a: '2026-06-01T12:00:00.000Z' },
      rateLimitedUntil: { codex: START },
    });
  });

  it('migrates each supported cache format and discards stale v1 update time', () => {
    const snapshot = ok('codex');
    const v1 = {
      format: 1,
      quotas: { codex: snapshot.ok ? snapshot.snapshot : undefined },
      usage: { providers: {}, machineCount: 2 },
      updatedAt: '2026-06-01T12:00:00.000Z',
      fired: { alert: '2026-06-02T12:00:00.000Z' },
    };
    expect(loadCachedState(v1)).toMatchObject({
      quotas: { codex: snapshot.ok ? snapshot.snapshot : undefined },
      usage: { providers: {}, machineCount: 2 },
      fired: { alert: '2026-06-02T12:00:00.000Z' },
    });
    expect(loadCachedState(v1).updatedAt).toBeUndefined();
    expect(loadCachedState({ ...v1, format: 2 }).updatedAt).toBe(v1.updatedAt);
    const empty = { quotas: {}, usage: undefined, fired: {}, rateLimitedUntil: {} };
    expect(loadCachedState({ ...v1, format: 3 })).toEqual(empty);
    expect(loadCachedState('garbage')).toEqual(empty);
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

  it('fills missing allTime on a pre-upgrade usage cache', () => {
    const empty = EMPTY_PERIOD;
    const today = { tokens: 10, costUSD: 1, hasCost: true, models: [] };
    const daily = [{ date: '2026-06-01', costUSD: 1 }];
    expect(
      loadCachedState({
        format: CACHE_FORMAT,
        usage: {
          providers: {
            claude_code: {
              today,
              yesterday: empty,
              last7Days: empty,
              last30Days: empty,
              daily,
            },
          },
          machineCount: 2,
        },
        fired: {},
      }),
    ).toEqual({
      quotas: {},
      usage: {
        providers: {
          claude_code: {
            today,
            yesterday: empty,
            last7Days: empty,
            last30Days: empty,
            allTime: empty,
            daily,
          },
        },
        machineCount: 2,
      },
      fired: {},
      rateLimitedUntil: {},
    });
  });

  it('keeps pull failures through local reads, retries after one minute and restores the normal schedule', async () => {
    const pull = vi
      .fn()
      .mockResolvedValueOnce({
        summary: { providers: {}, machineCount: 2 },
        warning: 'pull failed',
      })
      .mockResolvedValue({ summary: { providers: {}, machineCount: 2 } });
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
    const cached = persist.mock.calls.at(-1)?.[0];
    if (!cached) throw new Error('expected persisted cache');
    expect(cached.usageUpdatedAt).toBe(initial.usageUpdatedAt);
    expect(harness({}, {}, cached).service.state().usageUpdatedAt).toBe(initial.usageUpdatedAt);
  });

  it('retains both warnings when a pull and the following local read fail', async () => {
    const loadUsage = vi
      .fn<ServiceDeps['loadUsage']>()
      .mockResolvedValueOnce({ error: 'local read failed', warning: 'pull failed' })
      .mockResolvedValue({ summary: { providers: {}, machineCount: 1 } });
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
