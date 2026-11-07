import { statSync } from 'node:fs';
import { basename } from 'node:path';

import { resolveMachineId, tryLoadConfig } from '../config.js';
import { errorMessage } from '../errors.js';
import { isCloned, listDataFiles, readDataFile } from '../git.js';
import { machineDataFilename } from '../machineId.js';
import { log } from '../output.js';
import { resolveModelCost } from '../pricing/resolve.js';
import { isSyncedProvider, liveProviders, sortProviderKeys } from '../providers/index.js';
import { encryptionPassphrase } from '../store/encryption.js';
import { machineTimezone } from '../timezone.js';
import { sumDayMap } from './aggregate.js';
import {
  addCountsByKey,
  addTokenCounts,
  flagUnpriced,
  getOrCreateDay,
  mergeAllDayMaps,
} from './dayMap.js';
import {
  buildLocalMachineFile,
  machineHasData,
  mergePersistedDays,
  rebucketPersistedDays,
} from './localData.js';
import type { DayEntry, DayMap, MachineFile, ProviderData, ProviderDay } from './types.js';

export { usageEmptyMessage, usageEmptyWindowMessage } from './emptyState.js';

export function mergeProviderDay(
  rec: DayEntry,
  providerKey: string,
  pData: ProviderDay,
  date?: string,
): void {
  addTokenCounts(rec, { ...pData.totals, costUSD: undefined, hasUnpricedTokens: undefined }); // Cost follows the policy below.

  let summedModelCost = 0;
  let backfilledModelCost = 0;
  let hasModelCost = false;
  for (const [model, counts] of Object.entries(pData.byModel)) {
    const m = (rec.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
    const cost = resolveModelCost(providerKey, model, counts, date);
    addTokenCounts(m, {
      ...counts,
      costUSD: undefined,
      // A stored partial cost keeps its flag; a fresh estimate prices every token.
      hasUnpricedTokens:
        cost === undefined
          ? counts.inputTokens + counts.outputTokens > 0
          : counts.costUSD !== undefined && counts.hasUnpricedTokens === true,
    });
    if (m.hasUnpricedTokens) rec.hasUnpricedTokens = true;
    if (cost !== undefined) {
      m.costUSD = (m.costUSD ?? 0) + cost;
      summedModelCost += cost;
      hasModelCost = true;
      if (counts.costUSD === undefined) backfilledModelCost += cost; // Merge mode returns stored costs as-is.
    }
  }

  // Projects have no model to price from: their stored costs are summed as written.
  for (const [project, counts] of Object.entries(pData.byProject ?? {})) {
    addCountsByKey((rec.byProject ??= {}), project, flagUnpriced(counts));
  }
  for (const [cwd, counts] of Object.entries(pData.byCwd ?? {})) {
    addCountsByKey((rec.byCwd ??= {}), cwd, flagUnpriced(counts));
  }

  // Add only the backfill to a stored total; repricing history is recompute-costs' job.
  const dayCost =
    pData.totals.costUSD === undefined
      ? hasModelCost
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
  /** Awaited after the local logs are read and before synced files are, e.g. a concurrent pull. */
  syncedReady?: Promise<unknown>;
}

export interface PersistedMachine {
  filePath: string;
  machine: MachineFile;
}

/** One machine's days, still keyed by that machine's own calendar. */
export interface ZonedUsageSource {
  hostname: string;
  timezone: string;
  /** Empty for a machine only read from the local logs. */
  lastUpdated: string;
  /** The machine this process runs on. */
  current: boolean;
  days: MachineFile['days'];
}

/** What reports are built from. `providerData` is `zonedSources` and `liveProviderData` merged. */
export interface ZonedUsageData {
  providerData: ProviderData;
  /** Per-machine days before they are merged; relative windows apply in each source's timezone. */
  zonedSources: ZonedUsageSource[];
  /** Live providers (Cursor), in the viewing machine's timezone. */
  liveProviderData: ProviderData;
}

/** The root API's older shape, still returned by the loader and accepted by the report builders. */
export interface LoadedUsageData {
  providerData: ProviderData;
  /** Synced files only; `zonedSources` also holds a machine known only from its local logs. */
  machineData: MachineFile[];
  /** Same answer as `isUsageNotConfigured`. */
  warnedNotConfigured?: boolean;
  zonedSources?: ZonedUsageSource[];
  liveProviderData?: ProviderData;
}

export type UsageDataInput = ZonedUsageData | LoadedUsageData;

/** A merged map with no machine calendars is windowed like live data, on the viewer's calendar. */
export function zonedUsageData(loaded: UsageDataInput): ZonedUsageData {
  const { providerData, zonedSources, liveProviderData } = loaded;
  return zonedSources
    ? { providerData, zonedSources, liveProviderData: liveProviderData ?? {} }
    : { providerData, zonedSources: [], liveProviderData: providerData };
}

function overlayDays(providerData: ProviderData, days: MachineFile['days']): void {
  for (const [date, dayProviders] of Object.entries(days)) {
    for (const [providerKey, pData] of Object.entries(dayProviders)) {
      if (!isSyncedProvider(providerKey)) continue;
      const dayMap = (providerData[providerKey] ??= new Map());
      mergeProviderDay(getOrCreateDay(dayMap, date), providerKey, pData, date);
    }
  }
}

/** These machines merged with the live providers, priced the way every report prices them. */
export function mergeUsageSources(
  zonedSources: ZonedUsageSource[],
  liveProviderData: ProviderData = {},
): ZonedUsageData {
  const providerData: ProviderData = {};
  for (const source of zonedSources) overlayDays(providerData, source.days);
  return { providerData: { ...providerData, ...liveProviderData }, zonedSources, liveProviderData };
}

/**
 * Machines as reports should show them: other machines as synced, this machine
 * overlaid with the local logs so its totals match `show`. A machine that has
 * only been read locally is included with an empty `lastUpdated`.
 */
export async function loadReportedMachines(): Promise<MachineFile[]> {
  const config = tryLoadConfig();
  const machineId = resolveMachineId(config);
  return mergePersistedWithLocal(
    config && isCloned() ? loadPersistedMachines() : [],
    await buildLocalMachineFile(machineId),
    machineDataFilename(machineId),
  );
}

export interface MachineUsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Null when nothing could be priced. */
  costUSD: number | null;
  hasUnpricedTokens?: boolean;
  days: number;
  firstDay: string | null;
  lastDay: string | null;
  providers: string[];
}

/** One machine's totals through the merge `usage` uses, so the two agree on tokens and cost. */
export function machineUsageTotals(machine: MachineFile): MachineUsageTotals {
  const providerData: ProviderData = {};
  overlayDays(providerData, machine.days);
  const merged = mergeAllDayMaps(Object.values(providerData));
  const { inputTokens, outputTokens, costUSD, hasCost, days } = sumDayMap(merged);
  const activeDates = [...merged]
    .filter(([, day]) => day.inputTokens + day.outputTokens > 0)
    .map(([date]) => date)
    .toSorted();
  return {
    inputTokens,
    outputTokens,
    costUSD: hasCost ? costUSD : null,
    ...([...merged.values()].some((day) => day.hasUnpricedTokens) && { hasUnpricedTokens: true }),
    days,
    firstDay: activeDates[0] ?? null,
    lastDay: activeDates.at(-1) ?? null,
    providers: sortProviderKeys(Object.keys(providerData)),
  };
}

interface MachineFileMemo {
  mtimeMs: number;
  size: number;
  /** Decides whether an encrypted file parses at all, so a new one must read it again. */
  passphrase: string | undefined;
  machine: MachineFile | null;
}

let machineFileMemos = new Map<string, MachineFileMemo>();

/** Stat before reading: a write in between leaves a stale stamp, which only costs one more read. */
function readMemoizedMachine(filePath: string, next: Map<string, MachineFileMemo>) {
  let stamp;
  try {
    stamp = statSync(filePath);
  } catch {
    return readDataFile(filePath);
  }
  const { mtimeMs, size } = stamp;
  const passphrase = encryptionPassphrase();
  const known = machineFileMemos.get(filePath);
  const memo =
    known?.mtimeMs === mtimeMs && known.size === size && known.passphrase === passphrase
      ? known
      : { mtimeMs, size, passphrase, machine: readDataFile(filePath) };
  next.set(filePath, memo);
  return memo.machine;
}

/**
 * Synced machine files that parsed, with the path used to identify the current one. A long-lived
 * process re-reads only files that changed, so the result is shared between calls: do not mutate it.
 */
export function loadPersistedMachines(): PersistedMachine[] {
  const next = new Map<string, MachineFileMemo>();
  const machines = listDataFiles()
    .map((filePath) => ({ filePath, machine: readMemoizedMachine(filePath, next) }))
    .filter((entry): entry is PersistedMachine => entry.machine !== null);
  machineFileMemos = next;
  return machines;
}

/** Overlay this machine's local logs onto its persisted file through the same rule sync writes with. */
function mergePersistedWithLocal(
  persisted: PersistedMachine[],
  localMachine: MachineFile | null,
  currentFile: string,
): MachineFile[] {
  if (localMachine === null || !machineHasData(localMachine)) {
    return persisted.map(({ machine }) => machine);
  }
  const isCurrent = ({ filePath }: PersistedMachine) => basename(filePath) === currentFile;
  const machines = persisted.map((entry) =>
    isCurrent(entry)
      ? {
          ...entry.machine,
          timezone: localMachine.timezone,
          days: mergePersistedDays(
            rebucketPersistedDays(entry.machine, localMachine),
            localMachine.days,
          ),
        }
      : entry.machine,
  );
  if (!persisted.some((entry) => isCurrent(entry)))
    machines.push({ ...localMachine, lastUpdated: '' }); // Never synced.
  return machines;
}

/** Started before the JSONL read to overlap it; caught so an earlier throw leaves no unhandled rejection. */
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
        .catch((error: unknown): DayMap => {
          log.warn(`aitrack: ${provider.descriptor.label} skipped — ${errorMessage(error)}`);
          return new Map();
        }),
    }));
}

export async function loadMergedProviderData(
  options: LoadUsageOptions = {},
): Promise<(LoadedUsageData & ZonedUsageData) | null> {
  const config = tryLoadConfig();
  const machineId = resolveMachineId(config);
  const providerFilter = options.providers ? new Set(options.providers) : undefined;

  const livePending = startLiveFetches(providerFilter, options.refreshLive);
  const localMachine =
    options.localMachine === undefined
      ? await buildLocalMachineFile(machineId, undefined, options.providers, {
          includeLocalDirs: true,
        })
      : options.localMachine;
  await options.syncedReady;

  const notConfigured = !config || !isCloned();
  const persisted = notConfigured ? [] : loadPersistedMachines();
  const reportMachines = mergePersistedWithLocal(
    persisted,
    localMachine,
    machineDataFilename(machineId),
  );

  const zonedSources = reportMachines.map((machine): ZonedUsageSource => ({
    hostname: machine.hostname,
    timezone: machine.timezone,
    lastUpdated: machine.lastUpdated,
    current: machine.hostname === machineId,
    days: filterDaysByProviders(machine.days, providerFilter),
  }));

  const liveProviderData: ProviderData = {};
  for (const { key, pending } of livePending) {
    const liveMap = await pending;
    if (liveMap.size > 0) liveProviderData[key] = liveMap;
  }

  const merged = mergeUsageSources(zonedSources, liveProviderData);
  if (Object.keys(merged.providerData).length === 0) {
    return null;
  }

  return {
    ...merged,
    machineData: persisted.map((entry) => entry.machine),
    warnedNotConfigured: notConfigured,
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

/** Merge zoned machine files after each has been clipped to its own window. */
export function providerDataForWindows(
  loaded: UsageDataInput,
  windowFor: (timezone: string) => { start: string; end: string },
): ProviderData {
  const { zonedSources, liveProviderData } = zonedUsageData(loaded);
  const data: ProviderData = {};
  for (const source of zonedSources) {
    overlayDays(data, daysInWindow(source.days, windowFor(source.timezone)));
  }

  const liveWindow = windowFor(machineTimezone());
  for (const [key, dayMap] of Object.entries(liveProviderData)) {
    const filtered = new Map(
      [...dayMap].filter(([date]) => date >= liveWindow.start && date <= liveWindow.end),
    );
    if (filtered.size > 0) data[key] = filtered;
  }
  return data;
}
