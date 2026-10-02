import { isFiniteNumber, isRecord } from 'aitrack-lib/data/guards';
import type { MachineFile } from 'aitrack-lib/data/types';
import { errorMessage } from 'aitrack-lib/errors';
import { providerLabel } from 'aitrack-lib/providers/registry';
import { QUOTA_PROVIDERS } from 'aitrack-lib/quota/index';
import type { QuotaErrorKind, QuotaFormat, QuotaResult } from 'aitrack-lib/quota/types';

import type {
  AppState,
  PeriodUsage,
  ProviderState,
  ProviderUsage,
  QuotaProviderKey,
  QuotaSnapshot,
  QuotaWindow,
  Settings,
  Spend,
} from '../shared/types.js';
import { type Alert, dueAlerts, type FiredAlerts, pruneFired } from './alerts.js';
import type { UsageSummary } from './usage.js';

export const QUOTA_INTERVAL_MS = 5 * 60_000;
export const USAGE_INTERVAL_MS = 5 * 60_000;
export const PULL_INTERVAL_MS = 30 * 60_000;
export const FAILURE_BACKOFF_MS = 60_000;
const QUOTA_FORMATS: readonly QuotaFormat[] = ['percent', 'dollars', 'count'];

/** How long a failure waits before the next attempt; a retry-after can only lengthen it. */
const RETRY_AFTER_FAILURE_MS: Record<QuotaErrorKind, number> = {
  network: FAILURE_BACKOFF_MS,
  rateLimited: FAILURE_BACKOFF_MS,
  noCredentials: FAILURE_BACKOFF_MS,
  expired: FAILURE_BACKOFF_MS,
  auth: QUOTA_INTERVAL_MS,
  invalidResponse: QUOTA_INTERVAL_MS,
};

/** What survives a restart, so the popup has numbers before the first refresh. */
export interface CachedState {
  quotas: Partial<Record<QuotaProviderKey, QuotaSnapshot>>;
  usage?: UsageSummary;
  fired: FiredAlerts;
  /** Epoch ms a provider's retry-after ends; kept so a relaunch does not hit it again. */
  rateLimitedUntil?: Partial<Record<QuotaProviderKey, number>>;
}

function isSpend(value: unknown): value is Spend & Record<string, unknown> {
  return (
    isRecord(value) &&
    isFiniteNumber(value.tokens) &&
    isFiniteNumber(value.costUSD) &&
    typeof value.hasCost === 'boolean'
  );
}

function isPeriod(value: unknown): value is PeriodUsage {
  return (
    isSpend(value) &&
    Array.isArray(value.models) &&
    value.models.every((model) => isSpend(model) && typeof model.model === 'string')
  );
}

function isProviderUsage(value: unknown): value is ProviderUsage {
  return (
    isRecord(value) &&
    isPeriod(value.today) &&
    isPeriod(value.yesterday) &&
    isPeriod(value.last7Days) &&
    isPeriod(value.last30Days) &&
    Array.isArray(value.daily) &&
    value.daily.every(
      (day) => isRecord(day) && typeof day.date === 'string' && isFiniteNumber(day.costUSD),
    )
  );
}

function isWindow(value: unknown): value is QuotaWindow {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    isFiniteNumber(value.usedPercent) &&
    isFiniteNumber(value.periodSeconds) &&
    QUOTA_FORMATS.includes(value.format as QuotaFormat) &&
    (value.resetsAt === undefined || typeof value.resetsAt === 'string')
  );
}

function isSnapshot(value: unknown): value is QuotaSnapshot {
  return (
    isRecord(value) &&
    typeof value.fetchedAt === 'string' &&
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

function providerEntries<T>(value: unknown, keep: (entry: unknown) => entry is T) {
  const entries: Partial<Record<QuotaProviderKey, T>> = {};
  if (!isRecord(value)) return entries;
  for (const key of QUOTA_PROVIDERS) {
    const entry = value[key];
    if (keep(entry)) entries[key] = entry;
  }
  return entries;
}

/** A cache.json read from disk, which may be hand-edited: whatever does not fit is dropped. */
export function normalizeCachedState(input: unknown): CachedState {
  const raw = isRecord(input) ? input : {};
  const usage = isRecord(raw.usage) ? raw.usage : undefined;
  return {
    quotas: providerEntries(raw.quotas, isSnapshot),
    usage: usage && {
      providers: providerEntries(usage.providers, isProviderUsage),
      machineCount: isFiniteNumber(usage.machineCount) ? usage.machineCount : 1,
    },
    fired: Object.fromEntries(
      Object.entries(isRecord(raw.fired) ? raw.fired : {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    rateLimitedUntil: providerEntries(raw.rateLimitedUntil, isFiniteNumber),
  };
}

export interface ServiceDeps {
  fetchQuota: (provider: QuotaProviderKey) => Promise<QuotaResult>;
  loadUsage: (options: {
    pull: boolean;
    refreshLive: boolean;
    /** This machine's logs as a sync just read them, so they are not parsed again. */
    localMachine?: MachineFile;
  }) => Promise<{ summary: UsageSummary; warning?: string }>;
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
  private nextPullAt = 0;
  private usageError: string | undefined;
  private updatedAt: string | undefined;
  private syncing = false;
  private syncResult: AppState['syncResult'];
  private syncedMachine: MachineFile | undefined;
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
    this.emit();
  }

  state(): AppState {
    const providers = this.settings.providers
      .filter((provider) => provider.enabled)
      .map(({ key }): ProviderState => {
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
      usageError: this.usageError,
      updatedAt: this.updatedAt,
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
      const { message, machine } = await this.deps.sync();
      this.syncResult = { ok: true, message };
      this.syncedMachine = machine;
      this.nextPullAt = this.deps.now() + PULL_INTERVAL_MS; // The sync just pulled.
    } catch (error) {
      this.syncResult = { ok: false, message: errorMessage(error) };
    } finally {
      this.syncing = false;
    }
    this.emit();
    await this.usageRun;
    this.nextUsageAt = 0;
    await this.refresh();
  }

  /**
   * Refresh whatever is due. `force` (a user click) skips the schedule but
   * still honours a provider's retry-after, which it would only extend.
   */
  async refresh(force = false): Promise<void> {
    const now = this.deps.now();
    const due = this.settings.providers
      .filter(({ enabled }) => enabled)
      .map(({ key }) => key)
      .filter((key) => {
        const runtime = this.runtime.get(key);
        if (runtime?.refreshing) return false;
        if (runtime?.error?.kind === 'rateLimited') return now >= runtime.nextAttemptAt;
        return force || now >= (runtime?.nextAttemptAt ?? 0);
      });
    const usageDue =
      this.usageRun === undefined && !this.syncing && (force || now >= this.nextUsageAt);
    if (due.length === 0 && !usageDue) return;

    await Promise.all([
      ...due.map((key) => this.refreshQuota(key)),
      usageDue ? this.refreshUsage(force) : Promise.resolve(),
    ]);
    this.updatedAt = new Date(this.deps.now()).toISOString();
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
      runtime.nextAttemptAt = now + QUOTA_INTERVAL_MS;
      this.cache.quotas[key] = result.snapshot;
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

  private refreshUsage(force: boolean): Promise<void> {
    const run = this.loadUsage(force).finally(() => {
      this.usageRun = undefined;
    });
    this.usageRun = run;
    this.emit();
    return run;
  }

  private async loadUsage(force: boolean): Promise<void> {
    const now = this.deps.now();
    const pull = this.settings.pullSyncedData && (force || now >= this.nextPullAt);
    const localMachine = this.syncedMachine;
    this.syncedMachine = undefined;
    try {
      const { summary, warning } = await this.deps.loadUsage({
        pull,
        refreshLive: force,
        localMachine,
      });
      this.cache.usage = summary;
      this.usageError = warning;
      if (pull) this.nextPullAt = now + PULL_INTERVAL_MS;
      this.nextUsageAt = now + USAGE_INTERVAL_MS;
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
