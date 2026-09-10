import { basename } from 'node:path';

import { resolveMachineId, tryLoadConfig } from '../config.js';
import { isCloned, listDataFiles, readDataFile } from '../git.js';
import { machineDataFilename } from '../machineId.js';
import { resolveModelCost } from '../pricing/resolve.js';
import { isSyncedProvider, liveProviders } from '../providers/index.js';
import { addTokenCounts, getOrCreateDay } from './dayMap.js';
import { buildLocalMachineFile, machineHasData, mergePersistedDays } from './localData.js';
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

export interface LoadedUsageData {
  providerData: ProviderData;
  machineData: MachineFile[];
  warnedNotConfigured?: boolean;
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
): { machineData: MachineFile[]; providerData: ProviderData; isLocalMerged: boolean } {
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

  if (config && isCloned()) {
    const merged = mergePersistedWithLocal(
      loadPersistedMachines(),
      localMachine,
      machineDataFilename(machineId),
    );
    machineData = merged.machineData;
    providerData = merged.providerData;
    isLocalMerged = merged.isLocalMerged;
  }

  // Only when no persisted file absorbed it above; merging already covers it.
  if (localMachine !== null && !isLocalMerged && machineHasData(localMachine)) {
    overlayMachineFile(providerData, localMachine);
  }

  for (const { key, pending } of livePending) {
    const liveMap = await pending;
    if (liveMap.size > 0) providerData[key] = liveMap;
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
  };
}
