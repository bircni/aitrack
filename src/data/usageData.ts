import { hostname } from 'node:os';

import { resolveMachineId, tryLoadConfig } from '../config.js';
import { isSyncedProvider } from '../display/providers.js';
import { isCloned, listDataFiles, readDataFile, writePendingMachineFile } from '../git.js';
import { resolveModelCost } from '../pricing/resolve.js';
import { readCursorData } from '../readers/cursor/index.js';
import { filterProviderDataByYear, getOrCreateDay } from './dayMap.js';
import { buildLocalMachineFile, machineHasData } from './localData.js';
import type { DayEntry, MachineFile, ProviderData, ProviderDay } from './types.js';

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
    }
  }

  const dayCost = pData.totals.costUSD ?? (isAnyModelHadCost ? summedModelCost : undefined);
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
}

export interface LoadedUsageData {
  providerData: ProviderData;
  machineData: MachineFile[];
  fileCount: number;
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
  const machineId = config ? resolveMachineId(config) : hostname();
  const localMachine = await buildLocalMachineFile(machineId);

  if (options.stagePending) {
    writePendingMachineFile(localMachine);
  }

  const isWarnedNotConfigured = !config || !isCloned();

  let machineData: MachineFile[] = [];
  let providerData: ProviderData = {};
  let fileCount = 0;

  if (config && isCloned()) {
    const files = listDataFiles();
    fileCount = files.length;
    const currentFile = `${machineId}.json`;
    machineData = files
      .filter((f) => !f.endsWith(currentFile))
      .map(readDataFile)
      .filter((data): data is MachineFile => data !== null);
    providerData = splitByProvider(machineData);
  }

  if (machineHasData(localMachine)) {
    machineData.push(localMachine);
    overlayMachineFile(providerData, localMachine);
  }

  const providerFilter = options.providers ? new Set(options.providers) : undefined;

  if (!providerFilter || providerFilter.has('cursor')) {
    const cursorMap = await readCursorData();
    if (cursorMap.size > 0) providerData.cursor = cursorMap;
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
    fileCount,
    warnedNotConfigured: isWarnedNotConfigured,
  };
}
