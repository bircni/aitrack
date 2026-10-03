import type { MachineFile } from 'aitrack-lib/data/types';
import type { QuotaResult } from 'aitrack-lib/quota/types';
import { describe, expect, it, vi } from 'vitest';

import type { AppState, QuotaProviderKey } from '../../shared/types.js';
import { EMPTY_PERIOD } from '../../shared/types.js';
import type { Alert } from '../alerts.js';
import {
  FAILURE_BACKOFF_MS,
  normalizeCachedState,
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
) {
  let now = START;
  const calls: QuotaProviderKey[] = [];
  const pulls: boolean[] = [];
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
    loadUsage: ({ pull, localMachine }) => {
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
  const service = new QuotaService({ ...deps, ...overrides }, DEFAULT_SETTINGS);
  return {
    service,
    calls,
    pulls,
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

  it('reports usage failures and skips disabled providers', async () => {
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
  });

  it('keeps a retry-after across restarts', async () => {
    const limited: QuotaResult = {
      ok: false,
      error: { kind: 'rateLimited', message: 'slow', retryAfterSeconds: 600 },
    };
    const calls: QuotaProviderKey[] = [];
    let saved: CachedState | undefined;
    const deps = (fetch: (provider: QuotaProviderKey) => QuotaResult): ServiceDeps => ({
      fetchQuota: (provider) => {
        calls.push(provider);
        return Promise.resolve(fetch(provider));
      },
      loadUsage: () => Promise.resolve({ summary: { providers: {}, machineCount: 1 } }),
      now: () => START,
      onState: () => undefined,
      onAlert: () => undefined,
      persist: (cache) => {
        saved = structuredClone(cache);
      },
      sync: () => Promise.reject(new Error('unused')),
    });

    await new QuotaService(
      deps((provider) => (provider === 'claude_code' ? limited : ok(provider))),
      DEFAULT_SETTINGS,
    ).refresh();
    expect(saved?.rateLimitedUntil).toEqual({ claude_code: START + 600_000 });

    calls.length = 0;
    const restarted = new QuotaService(deps(ok), DEFAULT_SETTINGS, saved);
    expect(restarted.state().providers[0]?.quotaError?.kind).toBe('rateLimited');
    await restarted.refresh(true);
    expect(calls).toEqual(['codex', 'cursor']);
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
    const service = new QuotaService(
      {
        fetchQuota: () => Promise.resolve(cached),
        loadUsage: () => Promise.reject(new Error('unused')),
        now: () => START,
        onState: () => undefined,
        onAlert: () => undefined,
        persist: () => undefined,
        sync: () => Promise.reject(new Error('unused')),
      },
      DEFAULT_SETTINGS,
      { quotas: { codex: cached.ok ? cached.snapshot : undefined }, fired: {} },
    );
    expect(service.state().providers[1]?.quota?.provider).toBe('codex');
  });

  it('drops malformed parts of a hand-edited cache', () => {
    const snapshot = ok('codex');
    expect(
      normalizeCachedState({
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
    expect(normalizeCachedState('garbage')).toEqual({
      quotas: {},
      usage: undefined,
      fired: {},
      rateLimitedUntil: {},
    });
  });

  it.each([{ provider: 'claude_code' }, { plan: {} }, { usedValue: null }, { limitValue: '50' }])(
    'drops malformed quota snapshot fields: %j',
    ({ usedValue, limitValue, ...patch }) => {
      const result = ok('codex');
      if (!result.ok) throw new Error('expected quota');
      const snapshot = {
        ...result.snapshot,
        ...patch,
        windows: [{ ...result.snapshot.windows[0], format: 'dollars', usedValue, limitValue }],
      };
      expect(normalizeCachedState({ quotas: { codex: snapshot } }).quotas).toEqual({});
    },
  );

  it('fills missing allTime on a pre-upgrade usage cache', () => {
    const empty = EMPTY_PERIOD;
    const today = { tokens: 10, costUSD: 1, hasCost: true, models: [] };
    const daily = [{ date: '2026-06-01', costUSD: 1 }];
    expect(
      normalizeCachedState({
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
});
