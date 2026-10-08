import { isFiniteNumber, isRecord } from 'aitrack-lib/data/guards';
import type { MachineFile } from 'aitrack-lib/data/types';
import { errorMessage } from 'aitrack-lib/errors';
import { providerLabel } from 'aitrack-lib/providers/registry';
import { QUOTA_PROVIDERS } from 'aitrack-lib/quota/index';
import type { QuotaErrorKind, QuotaFormat, QuotaResult } from 'aitrack-lib/quota/types';

import type {
  AppState,
  MachineUsage,
  PeriodUsage,
  ProviderState,
  ProviderUsage,
  QuotaProviderKey,
  QuotaSnapshot,
  QuotaWindow,
  Settings,
  Spend,
} from '../shared/types.js';
import { EMPTY_PERIOD } from '../shared/types.js';
import { type Alert, dueAlerts, type FiredAlerts, pruneFired } from './alerts.js';
import type { UsageSummary } from './usage.js';

export const REFRESH_INTERVAL_MS = 5 * 60_000;
export const PULL_INTERVAL_MS = 30 * 60_000;
export const FAILURE_BACKOFF_MS = 60_000;
export const CACHE_FORMAT = 2;
const QUOTA_FORMATS: readonly QuotaFormat[] = ['percent', 'dollars', 'count'];

/** How long a failure waits before the next attempt; a retry-after can only lengthen it. */
const RETRY_AFTER_FAILURE_MS: Record<QuotaErrorKind, number> = {
  network: FAILURE_BACKOFF_MS,
  rateLimited: FAILURE_BACKOFF_MS,
  noCredentials: FAILURE_BACKOFF_MS,
  expired: FAILURE_BACKOFF_MS,
  auth: REFRESH_INTERVAL_MS,
  invalidResponse: REFRESH_INTERVAL_MS,
};

/** What survives a restart, so the popup has numbers before the first refresh. */
export interface CachedState {
  quotas: Partial<Record<QuotaProviderKey, QuotaSnapshot>>;
  usage?: UsageSummary;
  fired: FiredAlerts;
  updatedAt?: string;
  usageUpdatedAt?: string;
  pullError?: string;
  /** Epoch ms a provider's retry-after ends; kept so a relaunch does not hit it again. */
  rateLimitedUntil?: Partial<Record<QuotaProviderKey, number>>;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSpend(value: unknown): value is Spend & Record<string, unknown> {
  return (
    isRecord(value) &&
    isFiniteNumber(value.tokens) &&
    isFiniteNumber(value.costUSD) &&
    typeof value.hasCost === 'boolean' &&
    (value.hasUnpricedTokens === undefined || typeof value.hasUnpricedTokens === 'boolean')
  );
}

function isPeriod(value: unknown): value is PeriodUsage {
  return (
    isSpend(value) &&
    Array.isArray(value.models) &&
    value.models.every((model) => isSpend(model) && typeof model.model === 'string')
  );
}

/** Pre-allTime caches keep other periods; missing allTime becomes an empty period. */
function readProviderUsage(value: unknown): ProviderUsage | undefined {
  if (
    !isRecord(value) ||
    !isPeriod(value.today) ||
    !isPeriod(value.yesterday) ||
    !isPeriod(value.last7Days) ||
    !isPeriod(value.last30Days) ||
    !Array.isArray(value.daily)
  ) {
    return undefined;
  }
  const daily: ProviderUsage['daily'] = [];
  for (const day of value.daily) {
    if (!isRecord(day) || typeof day.date !== 'string' || !isFiniteNumber(day.costUSD)) {
      return undefined;
    }
    daily.push({ date: day.date, costUSD: day.costUSD });
  }
  return {
    today: value.today,
    yesterday: value.yesterday,
    last7Days: value.last7Days,
    last30Days: value.last30Days,
    allTime: isPeriod(value.allTime) ? value.allTime : EMPTY_PERIOD,
    daily,
  };
}

function readMachineUsage(value: unknown): MachineUsage | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.timezone !== 'string' ||
    typeof value.lastUpdated !== 'string' ||
    typeof value.current !== 'boolean'
  ) {
    return undefined;
  }
  return {
    name: value.name,
    timezone: value.timezone,
    lastUpdated: value.lastUpdated,
    current: value.current,
    providers: providerMap(value.providers, readProviderUsage),
  };
}

function isWindow(value: unknown): value is QuotaWindow {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    isFiniteNumber(value.usedPercent) &&
    isFiniteNumber(value.periodSeconds) &&
    QUOTA_FORMATS.includes(value.format as QuotaFormat) &&
    (value.resetsAt === undefined || typeof value.resetsAt === 'string') &&
    (value.usedValue === undefined || isFiniteNumber(value.usedValue)) &&
    (value.limitValue === undefined || isFiniteNumber(value.limitValue))
  );
}

function isSnapshot(value: unknown, key: QuotaProviderKey): value is QuotaSnapshot {
  return (
    isRecord(value) &&
    value.provider === key &&
    (value.plan === undefined || typeof value.plan === 'string') &&
    isTimestamp(value.fetchedAt) &&
    Array.isArray(value.windows) &&
    value.windows.every(isWindow) &&
    Array.isArray(value.values) &&
    value.values.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.label === 'string' &&
        isFiniteNumber(entry.value) &&
        (entry.format === 'dollars' || entry.format === 'count'),
    )
  );
}

function providerMap<T>(
  value: unknown,
  read: (entry: unknown, key: QuotaProviderKey) => T | undefined,
): Partial<Record<QuotaProviderKey, T>> {
  const entries: Partial<Record<QuotaProviderKey, T>> = {};
  if (!isRecord(value)) return entries;
  for (const key of QUOTA_PROVIDERS) {
    const entry = read(value[key], key);
    if (entry !== undefined) entries[key] = entry;
  }
  return entries;
}

/** A cache.json read from disk, which may be hand-edited: whatever does not fit is dropped. */
function normalizeCachedState(input: unknown): CachedState {
  const raw = isRecord(input) ? input : {};
  const usage = isRecord(raw.usage) ? raw.usage : undefined;
  return {
    ...(isTimestamp(raw.updatedAt) && { updatedAt: raw.updatedAt }),
    ...(isTimestamp(raw.usageUpdatedAt) && { usageUpdatedAt: raw.usageUpdatedAt }),
    ...(typeof raw.pullError === 'string' && { pullError: raw.pullError }),
    quotas: providerMap(raw.quotas, (entry, key) => (isSnapshot(entry, key) ? entry : undefined)),
    usage: usage && {
      providers: providerMap(usage.providers, readProviderUsage),
      machineCount: isFiniteNumber(usage.machineCount) ? usage.machineCount : 1,
      ...(Array.isArray(usage.machines) && {
        machines: usage.machines
          .map((machine) => readMachineUsage(machine))
          .filter((machine) => machine !== undefined),
      }),
      ...(isRecord(usage.account) && {
        account: providerMap(usage.account, readProviderUsage),
      }),
    },
    fired: Object.fromEntries(
      Object.entries(isRecord(raw.fired) ? raw.fired : {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    rateLimitedUntil: providerMap(raw.rateLimitedUntil, (entry) =>
      isFiniteNumber(entry) ? entry : undefined,
    ),
  };
}

type CacheMigration = (cache: Record<string, unknown>) => Record<string, unknown>;

const CACHE_MIGRATIONS: Record<number, CacheMigration> = {
  1: ({ updatedAt: _updatedAt, ...cache }) => cache,
};

export function loadCachedState(input: unknown): CachedState {
  if (
    !isRecord(input) ||
    typeof input.format !== 'number' ||
    !Number.isInteger(input.format) ||
    input.format < 1
  ) {
    return normalizeCachedState({});
  }
  let version = input.format;
  let cache = input;
  while (version < CACHE_FORMAT) {
    const migrate = CACHE_MIGRATIONS[version];
    if (!migrate) return normalizeCachedState({});
    cache = { ...migrate(cache), format: ++version };
  }
  return version === CACHE_FORMAT ? normalizeCachedState(cache) : normalizeCachedState({});
}

function providersKey(providers: readonly QuotaProviderKey[]): string {
  return providers.toSorted().join();
}

export interface ServiceDeps {
  fetchQuota: (provider: QuotaProviderKey) => Promise<QuotaResult>;
  loadUsage: (options: {
    /** Only enabled providers are read, so a disabled Cursor is never contacted. */
    providers: QuotaProviderKey[];
    pull: boolean;
    refreshLive: boolean;
    /** This machine's logs as a sync just read them, so they are not parsed again. */
    localMachine?: MachineFile;
  }) => Promise<{ summary: UsageSummary; warning?: string } | { error: string; warning?: string }>;
  now: () => number;
  onState: (state: AppState) => void;
  onAlert: (alert: Alert) => void;
  persist: (cache: CachedState) => void;
  /** Resolves with the one-line outcome and the machine file it built. */
  sync: () => Promise<{ message: string; machine: MachineFile }>;
}

interface ProviderRuntime {
  refreshing: boolean;
  nextAttemptAt: number;
  error?: ProviderState['quotaError'];
}

export class QuotaService {
  private readonly runtime = new Map<QuotaProviderKey, ProviderRuntime>();
  private usageRun: Promise<void> | undefined;
  private nextUsageAt = 0;
  /** Sorted providers the last usage load read; a change makes usage due so a re-enabled one shows. */
  private usageProviders: string | undefined;
  private nextPullAt = 0;
  private usageError: string | undefined;
  private syncing = false;
  private syncResult: AppState['syncResult'];
  private emitQueued = false;

  private readonly cache: CachedState;

  constructor(
    private readonly deps: ServiceDeps,
    private settings: Settings,
    cache?: CachedState,
  ) {
    this.cache = cache ?? { quotas: {}, fired: {} };
    const now = deps.now();
    for (const [key, until] of Object.entries(this.cache.rateLimitedUntil ?? {})) {
      if (until <= now) continue;
      this.runtime.set(key as QuotaProviderKey, {
        refreshing: false,
        nextAttemptAt: until,
        error: { kind: 'rateLimited', message: 'Rate limited; retrying later' },
      });
    }
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    if (!settings.pullSyncedData) this.cache.pullError = undefined;
    this.emit();
  }

  state(): AppState {
    const providers = this.enabledProviders().map((key): ProviderState => {
      const runtime = this.runtime.get(key);
      return {
        key,
        label: providerLabel(key),
        quota: this.cache.quotas[key],
        quotaError: runtime?.error,
        retryAt: runtime?.error?.kind === 'rateLimited' ? runtime.nextAttemptAt : undefined,
        usage: this.cache.usage?.providers[key],
        refreshing: runtime?.refreshing ?? false,
      };
    });
    return {
      providers,
      refreshing: this.usageRun !== undefined || providers.some((provider) => provider.refreshing),
      machineCount: this.cache.usage?.machineCount ?? 1,
      machines: this.cache.usage?.machines,
      accountUsage: this.cache.usage?.account,
      usageError: this.usageError,
      updatedAt: this.cache.updatedAt,
      usageUpdatedAt: this.cache.usageUpdatedAt,
      pullError: this.settings.pullSyncedData ? this.cache.pullError : undefined,
      syncing: this.syncing,
      syncResult: this.syncResult,
    };
  }

  /** Push this machine's usage like `aitrack sync`, then reload so the totals include it. */
  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.emit();
    try {
      let localMachine: MachineFile | undefined;
      try {
        const { message, machine } = await this.deps.sync();
        this.syncResult = { ok: true, message };
        localMachine = machine;
        this.nextPullAt = this.deps.now() + PULL_INTERVAL_MS;
        this.cache.pullError = undefined;
      } catch (error) {
        this.syncResult = { ok: false, message: errorMessage(error) };
      }
      await this.usageRun;
      await Promise.all([
        this.refresh(),
        this.refreshUsage(false, this.enabledProviders(), localMachine),
      ]);
    } finally {
      this.syncing = false;
      this.persist();
    }
  }

  /**
   * Refresh whatever is due. `force` (a user click) skips the schedule but
   * still honours a provider's retry-after, which it would only extend.
   */
  async refresh(force = false): Promise<void> {
    const now = this.deps.now();
    const providers = this.enabledProviders();
    const due = providers.filter((key) => {
      const runtime = this.runtime.get(key);
      if (runtime?.refreshing) return false;
      if (runtime?.error?.kind === 'rateLimited') return now >= runtime.nextAttemptAt;
      return force || now >= (runtime?.nextAttemptAt ?? 0);
    });
    const usageDue =
      this.usageRun === undefined &&
      !this.syncing &&
      (force || now >= this.nextUsageAt || providersKey(providers) !== this.usageProviders);
    if (due.length === 0 && !usageDue) return;

    await Promise.all([
      ...due.map((key) => this.refreshQuota(key)),
      usageDue ? this.refreshUsage(force, providers) : Promise.resolve(),
    ]);
    this.persist();
  }

  private enabledProviders(): QuotaProviderKey[] {
    return this.settings.providers.filter(({ enabled }) => enabled).map(({ key }) => key);
  }

  private persist(): void {
    this.cache.fired = pruneFired(this.cache.fired, this.deps.now());
    this.cache.rateLimitedUntil = Object.fromEntries(
      [...this.runtime]
        .filter(([, runtime]) => runtime.error?.kind === 'rateLimited')
        .map(([key, runtime]) => [key, runtime.nextAttemptAt]),
    );
    this.deps.persist(this.cache);
    this.emit();
  }

  private async refreshQuota(key: QuotaProviderKey): Promise<void> {
    const runtime: ProviderRuntime = this.runtime.get(key) ?? {
      refreshing: false,
      nextAttemptAt: 0,
    };
    runtime.refreshing = true;
    this.runtime.set(key, runtime);
    this.emit();
    const result = await this.deps.fetchQuota(key);
    const now = this.deps.now();
    runtime.refreshing = false;
    if (result.ok) {
      runtime.error = undefined;
      runtime.nextAttemptAt = now + REFRESH_INTERVAL_MS;
      this.cache.quotas[key] = result.snapshot;
      this.cache.updatedAt = new Date(now).toISOString();
      this.alertFor(key, result.snapshot, now);
    } else {
      runtime.error = result.error;
      runtime.nextAttemptAt =
        now +
        Math.max(
          RETRY_AFTER_FAILURE_MS[result.error.kind],
          (result.error.retryAfterSeconds ?? 0) * 1000,
        );
      // A signed-out provider's old numbers would be misleading, not just stale.
      if (result.error.kind === 'noCredentials') this.cache.quotas[key] = undefined;
    }
    this.emit();
  }

  private alertFor(key: QuotaProviderKey, snapshot: QuotaSnapshot, now: number): void {
    if (!this.settings.notifications) return;
    for (const alert of dueAlerts(providerLabel(key), snapshot, this.cache.fired, now)) {
      this.cache.fired[alert.key] = alert.resetsAt;
      this.deps.onAlert(alert);
    }
  }

  private refreshUsage(
    force: boolean,
    providers: QuotaProviderKey[],
    localMachine?: MachineFile,
  ): Promise<void> {
    const run = this.loadUsage(force, providers, localMachine).finally(() => {
      this.usageRun = undefined;
      this.emit(); // Usage shows now rather than with the slowest quota fetch.
    });
    this.usageRun = run;
    this.emit();
    return run;
  }

  private async loadUsage(
    force: boolean,
    providers: QuotaProviderKey[],
    localMachine?: MachineFile,
  ): Promise<void> {
    const now = this.deps.now();
    const pull = this.settings.pullSyncedData && (force || now >= this.nextPullAt);
    this.usageProviders = providersKey(providers);
    try {
      const result = await this.deps.loadUsage({
        providers,
        pull,
        refreshLive: force,
        localMachine,
      });
      const completedAt = this.deps.now();
      if (pull) {
        this.cache.pullError = result.warning;
        this.nextPullAt = completedAt + (result.warning ? FAILURE_BACKOFF_MS : PULL_INTERVAL_MS);
      }
      if ('error' in result) throw new Error(result.error);
      this.cache.usage = result.summary;
      this.usageError = undefined;
      this.cache.usageUpdatedAt = new Date(completedAt).toISOString();
      this.cache.updatedAt = this.cache.usageUpdatedAt;
      this.nextUsageAt =
        completedAt +
        (this.cache.pullError && this.settings.pullSyncedData
          ? FAILURE_BACKOFF_MS
          : REFRESH_INTERVAL_MS);
    } catch (error) {
      this.usageError = errorMessage(error);
      this.nextUsageAt = now + FAILURE_BACKOFF_MS;
    }
  }

  /** Several changes in one tick (a refresh starting every provider at once) push one state. */
  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.deps.onState(this.state());
    });
  }
}
