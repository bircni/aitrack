import { basename } from 'node:path';

import { resolveMachineId, tryLoadConfig } from '../config.js';
import { isCloned, listDataFiles, readDataFile } from '../git.js';
import { machineDataFilename } from '../machineId.js';
import { resolveModelCost } from '../pricing/resolve.js';
import { isSyncedProvider, liveProviders } from '../providers/index.js';
import { machineTimezone } from '../timezone.js';
import { addTokenCounts, getOrCreateDay } from './dayMap.js';
import { buildLocalMachineFile, machineHasData, mergePersistedDays } from './localData.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import type { DayEntry, DayMap, MachineFile, ProviderData, ProviderDay } from './types.js';

export { usageEmptyMessage, usageEmptyWindowMessage } from './emptyState.js';

// Merge one provider-day record into the running accumulator for that day.
// Day cost prefers the stored totals.costUSD; falls back to the sum of per-model
// costs when totals are missing but at least one model had a (possibly
// backfilled) cost.
export function mergeProviderDay(
  rec: DayEntry,
  providerKey: string,
  pData: ProviderDay,
  date?: string,
): void {
  // Token fields only. Day cost is a stored-total-plus-backfill policy, not a
  // straight sum of the incoming totals and model rows.
  addTokenCounts(rec, { ...pData.totals, costUSD: undefined });

  let summedModelCost = 0;
  let backfilledModelCost = 0;
  let isAnyModelHadCost = false;
  for (const [model, counts] of Object.entries(pData.byModel)) {
    const m = (rec.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
    addTokenCounts(m, { ...counts, costUSD: undefined });
    const cost = resolveModelCost(providerKey, model, counts, date);
    if (cost !== undefined) {
      m.costUSD = (m.costUSD ?? 0) + cost;
      summedModelCost += cost;
      isAnyModelHadCost = true;
      // In merge mode resolveModelCost returns the stored cost when there is
      // one, so this is exactly the amount that was estimated just now.
      if (counts.costUSD === undefined) backfilledModelCost += cost;
    }
  }

  // A stored day total predates any per-model cost estimated above, so the
  // model table would otherwise total more than the day it belongs to. Add the
  // backfilled amount in rather than recomputing the whole day, which would
  // silently reprice history that recompute-costs owns.
  const dayCost =
    pData.totals.costUSD === undefined
      ? isAnyModelHadCost
        ? summedModelCost
        : undefined
      : pData.totals.costUSD + backfilledModelCost;
  if (dayCost !== undefined) rec.costUSD = (rec.costUSD ?? 0) + dayCost;
}

export interface LoadUsageOptions {
  /**
   * Restrict the loaded data to these canonical provider keys. When omitted,
   * every available provider is loaded. Cursor is only read from local state
   * when it is included (or when the filter is absent).
   */
  providers?: string[];
  /**
   * Ignore any cached live-provider (Cursor) data and re-fetch. Without this a
   * cached CSV export younger than the TTL is served without a network call.
   */
  refreshLive?: boolean;
  /**
   * Already-read local machine file. When provided (including `null` to skip
   * the logs), the loader does not parse the JSONL corpus again.
   */
  localMachine?: MachineFile | null;
}

export interface PersistedMachine {
  filePath: string;
  machine: MachineFile;
}

/** One machine's days, still keyed by that machine's own calendar. */
export interface ZonedUsageSource {
  timezone: string;
  days: MachineFile['days'];
}

export interface LoadedUsageData {
  providerData: ProviderData;
  machineData: MachineFile[];
  warnedNotConfigured?: boolean;
  /**
   * Per-machine days before they are merged. Relative usage windows are
   * applied in each source's timezone. Absent on callers that only have the
   * already-merged map.
   */
  zonedSources?: ZonedUsageSource[];
  /** Live providers (Cursor), in the viewing machine's timezone. */
  liveProviderData?: ProviderData;
}

function overlayMachineFile(providerData: ProviderData, machine: MachineFile): void {
  for (const [date, dayProviders] of Object.entries(machine.days)) {
    for (const [providerKey, pData] of Object.entries(dayProviders)) {
      if (!isSyncedProvider(providerKey)) continue;
      const dayMap = (providerData[providerKey] ??= new Map());
      mergeProviderDay(getOrCreateDay(dayMap, date), providerKey, pData, date);
    }
  }
}

function splitByProvider(machineFiles: MachineFile[]): ProviderData {
  const providers: ProviderData = {};
  for (const file of machineFiles) {
    overlayMachineFile(providers, file);
  }
  return providers;
}

/** Synced machine files that parsed, with the path used to identify the current one. */
export function loadPersistedMachines(): PersistedMachine[] {
  return listDataFiles()
    .map((filePath) => ({ filePath, machine: readDataFile(filePath) }))
    .filter((entry): entry is PersistedMachine => entry.machine !== null);
}

/**
 * Overlay this machine's local logs onto its persisted file through the same
 * rule sync writes with, then split the result by provider.
 */
function mergePersistedWithLocal(
  persisted: PersistedMachine[],
  localMachine: MachineFile | null,
  currentFile: string,
): {
  machineData: MachineFile[];
  reportMachines: MachineFile[];
  providerData: ProviderData;
  isLocalMerged: boolean;
} {
  const machineData = persisted.map((entry) => entry.machine);
  const reportMachines: MachineFile[] = [];
  let isLocalMerged = false;

  for (const entry of persisted) {
    if (
      localMachine === null ||
      basename(entry.filePath) !== currentFile ||
      !machineHasData(localMachine)
    ) {
      reportMachines.push(entry.machine);
      continue;
    }
    reportMachines.push({
      ...entry.machine,
      days: mergePersistedDays(entry.machine.days, localMachine.days),
    });
    isLocalMerged = true;
  }

  return {
    machineData,
    reportMachines,
    providerData: splitByProvider(reportMachines),
    isLocalMerged,
  };
}

/**
 * Start live-provider fetches now so they overlap the JSONL read.
 *
 * The catch matters because the promise is started before later awaits: if one
 * of those threw first, an unguarded rejection here would surface as an
 * unhandled rejection rather than the original error.
 */
function startLiveFetches(
  providerFilter: Set<string> | undefined,
  refreshLive?: boolean,
): Array<{ key: string; pending: Promise<DayMap> }> {
  // `0` forces a refresh; `undefined` lets each live provider apply its own TTL.
  const liveMaxAgeSeconds = refreshLive ? 0 : undefined;
  return liveProviders()
    .filter((provider) => !providerFilter || providerFilter.has(provider.descriptor.key))
    .map((provider) => ({
      key: provider.descriptor.key,
      pending: provider.live
        .liveFetch({ maxAgeSeconds: liveMaxAgeSeconds })
        .catch((): DayMap => new Map()),
    }));
}

export async function loadMergedProviderData(
  options: LoadUsageOptions = {},
): Promise<LoadedUsageData | null> {
  const config = tryLoadConfig();
  const machineId = resolveMachineId(config ?? { repoUrl: '' });
  const providerFilter = options.providers ? new Set(options.providers) : undefined;

  const livePending = startLiveFetches(providerFilter, options.refreshLive);
  const localMachine =
    options.localMachine === undefined
      ? await buildLocalMachineFile(machineId)
      : options.localMachine;

  const isWarnedNotConfigured = !config || !isCloned();

  let machineData: MachineFile[] = [];
  let providerData: ProviderData = {};
  let isLocalMerged = false;
  const zonedSources: ZonedUsageSource[] = [];

  if (config && isCloned()) {
    const merged = mergePersistedWithLocal(
      loadPersistedMachines(),
      localMachine,
      machineDataFilename(machineId),
    );
    machineData = merged.machineData;
    providerData = merged.providerData;
    isLocalMerged = merged.isLocalMerged;
    for (const machine of merged.reportMachines) {
      zonedSources.push({
        timezone: machine.timezone,
        days: filterDaysByProviders(machine.days, providerFilter),
      });
    }
  }

  // Only when no persisted file absorbed it above; merging already covers it.
  if (localMachine !== null && !isLocalMerged && machineHasData(localMachine)) {
    overlayMachineFile(providerData, localMachine);
    zonedSources.push({
      timezone: localMachine.timezone,
      days: filterDaysByProviders(localMachine.days, providerFilter),
    });
  }

  const liveProviderData: ProviderData = {};
  for (const { key, pending } of livePending) {
    const liveMap = await pending;
    if (liveMap.size > 0) {
      liveProviderData[key] = liveMap;
      providerData[key] = liveMap;
    }
  }

  if (providerFilter) {
    providerData = Object.fromEntries(
      Object.entries(providerData).filter(([key]) => providerFilter.has(key)),
    );
  }

  if (Object.keys(providerData).length === 0) {
    return null;
  }

  return {
    providerData,
    machineData,
    warnedNotConfigured: isWarnedNotConfigured,
    zonedSources,
    liveProviderData,
  };
}

function filterDaysByProviders(
  days: MachineFile['days'],
  providerFilter: Set<string> | undefined,
): MachineFile['days'] {
  if (!providerFilter) return days;
  const filtered: MachineFile['days'] = {};
  for (const [date, providers] of Object.entries(days)) {
    const kept = Object.fromEntries(
      Object.entries(providers).filter(([providerKey]) => providerFilter.has(providerKey)),
    );
    if (Object.keys(kept).length > 0) filtered[date] = kept;
  }
  return filtered;
}

function daysInWindow(
  days: MachineFile['days'],
  window: { start: string; end: string },
): MachineFile['days'] {
  const filtered: MachineFile['days'] = {};
  for (const [date, providers] of Object.entries(days)) {
    if (date >= window.start && date <= window.end) filtered[date] = providers;
  }
  return filtered;
}

/**
 * Merge zoned machine files after each has been clipped to its own window.
 * Without `zonedSources`, the already-merged map is returned unchanged.
 */
export function providerDataForWindows(
  loaded: LoadedUsageData,
  windowFor: (timezone: string) => { start: string; end: string },
): ProviderData {
  if (!loaded.zonedSources) return loaded.providerData;

  const data: ProviderData = {};
  for (const source of loaded.zonedSources) {
    overlayMachineFile(data, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      hostname: source.timezone,
      timezone: source.timezone,
      dayBucket: 'local',
      lastUpdated: '',
      days: daysInWindow(source.days, windowFor(source.timezone)),
    });
  }

  const { liveProviderData } = loaded;
  if (!liveProviderData) return data;
  const liveWindow = windowFor(machineTimezone());
  for (const [key, dayMap] of Object.entries(liveProviderData)) {
    const filtered = new Map(
      [...dayMap].filter(([date]) => date >= liveWindow.start && date <= liveWindow.end),
    );
    if (filtered.size > 0) data[key] = filtered;
  }
  return data;
}
