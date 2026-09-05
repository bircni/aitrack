import { basename } from 'node:path';

import { resolveMachineId, tryLoadConfig } from '../config.js';
import { isCloned, listDataFiles, readDataFile, writePendingMachineFile } from '../git.js';
import { machineDataFilename } from '../machineId.js';
import { resolveModelCost } from '../pricing/resolve.js';
import { isSyncedProvider, liveProviders } from '../providers/index.js';
import { filterProviderDataByYear, getOrCreateDay } from './dayMap.js';
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
  rec.inputTokens += pData.totals.inputTokens;
  rec.outputTokens += pData.totals.outputTokens;
  if (pData.totals.cachedInputTokens !== undefined) {
    rec.cachedInputTokens = (rec.cachedInputTokens ?? 0) + pData.totals.cachedInputTokens;
  }
  if (pData.totals.rawInputTokens !== undefined) {
    rec.rawInputTokens = (rec.rawInputTokens ?? 0) + pData.totals.rawInputTokens;
  }
  if (pData.totals.cacheCreationInputTokens !== undefined) {
    rec.cacheCreationInputTokens =
      (rec.cacheCreationInputTokens ?? 0) + pData.totals.cacheCreationInputTokens;
  }

  let summedModelCost = 0;
  let backfilledModelCost = 0;
  let isAnyModelHadCost = false;
  for (const [model, counts] of Object.entries(pData.byModel)) {
    const m = (rec.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
    m.inputTokens += counts.inputTokens;
    m.outputTokens += counts.outputTokens;
    if (counts.cachedInputTokens !== undefined) {
      m.cachedInputTokens = (m.cachedInputTokens ?? 0) + counts.cachedInputTokens;
    }
    if (counts.rawInputTokens !== undefined) {
      m.rawInputTokens = (m.rawInputTokens ?? 0) + counts.rawInputTokens;
    }
    if (counts.cacheCreationInputTokens !== undefined) {
      m.cacheCreationInputTokens =
        (m.cacheCreationInputTokens ?? 0) + counts.cacheCreationInputTokens;
    }
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
  year?: number;
  /** Stage local machine JSON under ~/.config/aitrack/pending/ for later init adoption. */
  stagePending?: boolean;
  /**
   * Report only what is already synced to the repo, without reading this
   * machine's JSONL logs at all. `machines` summarizes the persisted files and
   * never looks at the merged day maps, and parsing a large corpus for data it
   * then discards was the bulk of that command's runtime.
   */
  skipLocalLogs?: boolean;
  /**
   * Ignore any cached live-provider (Cursor) data and re-fetch. Without this a
   * cached CSV export younger than the TTL is served without a network call.
   */
  refreshLive?: boolean;
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

export async function loadMergedProviderData(
  options: LoadUsageOptions = {},
): Promise<LoadedUsageData | null> {
  const config = tryLoadConfig();
  const machineId = resolveMachineId(config ?? { repoUrl: '' });

  // A live provider (Cursor) is an HTTPS round-trip and the rest of this is disk
  // and CPU work, so start it now and collect it at the end rather than paying
  // for it in series.
  const providerFilter = options.providers ? new Set(options.providers) : undefined;
  // The catch matters because the promise is started before the awaits below:
  // if one of those threw first, an unguarded rejection here would surface as
  // an unhandled rejection rather than the original error.
  // `0` forces a refresh; `undefined` lets each live provider apply its own
  // cache TTL.
  const liveMaxAgeSeconds = options.refreshLive ? 0 : undefined;
  const livePending = liveProviders()
    .filter((provider) => !providerFilter || providerFilter.has(provider.descriptor.key))
    .map((provider) => ({
      key: provider.descriptor.key,
      pending: provider.live
        .liveFetch({ maxAgeSeconds: liveMaxAgeSeconds })
        .catch((): DayMap => new Map()),
    }));

  const localMachine = options.skipLocalLogs ? null : await buildLocalMachineFile(machineId);

  const isWarnedNotConfigured = !config || !isCloned();

  // Staging exists so a later `init` can adopt usage recorded before the repo
  // was set up. Once the machine is configured and cloned, sync writes into the
  // repo directly and a staged copy would only collide with the synced file the
  // next time init runs.
  if (localMachine && options.stagePending && isWarnedNotConfigured) {
    writePendingMachineFile(localMachine);
  }

  let machineData: MachineFile[] = [];
  let providerData: ProviderData = {};
  let isLocalMerged = false;

  if (config && isCloned()) {
    const files = listDataFiles();
    const currentFile = machineDataFilename(machineId);
    const persisted = files
      .map((filePath) => ({ filePath, machine: readDataFile(filePath) }))
      .filter(
        (entry): entry is { filePath: string; machine: MachineFile } => entry.machine !== null,
      );
    machineData = persisted.map((entry) => entry.machine);

    const reportMachines: MachineFile[] = [];
    for (const entry of persisted) {
      if (
        localMachine === null ||
        basename(entry.filePath) !== currentFile ||
        !machineHasData(localMachine)
      ) {
        reportMachines.push(entry.machine);
        continue;
      }
      // Merge the local logs into the current machine's persisted days through
      // the same rule sync writes with, so what is displayed matches what the
      // file holds — including a boundary day whose logs have been pruned down
      // below what was synced from them earlier.
      reportMachines.push({
        ...entry.machine,
        days: mergePersistedDays(entry.machine.days, localMachine.days),
      });
      isLocalMerged = true;
    }
    providerData = splitByProvider(reportMachines);
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

  const filtered =
    options.year === undefined
      ? providerData
      : filterProviderDataByYear(providerData, options.year);

  if (Object.keys(filtered).length === 0) {
    return null;
  }

  return {
    providerData: filtered,
    machineData,
    warnedNotConfigured: isWarnedNotConfigured,
  };
}
