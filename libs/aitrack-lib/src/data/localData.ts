import { OPTIONAL_TOKEN_NUMBER_FIELDS } from '../constants.js';
import type { FallbackCollector } from '../pricing/fallback.js';
import { syncedProviders } from '../providers/index.js';
import { machineTimezone, UNKNOWN_TIMEZONE } from '../timezone.js';
import { shiftDate } from './calendar.js';
import { compactDays, isCompactedDay } from './compact.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import type { DayMap, MachineFile, ProviderDay, TokenCounts } from './types.js';

export { machineTimezone };

function tokenCountFields(counts: TokenCounts): TokenCounts {
  const fields: TokenCounts = {
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
  };
  for (const field of OPTIONAL_TOKEN_NUMBER_FIELDS) {
    const value = counts[field];
    if (value !== undefined) fields[field] = value;
  }
  if (counts.hasUnpricedTokens) fields.hasUnpricedTokens = true;
  return fields;
}

/** Sorted by key, so the serialized file does not change when only the read order did. */
function sortedCounts(
  byKey: Record<string, TokenCounts> | undefined,
): Record<string, TokenCounts> | undefined {
  if (byKey === undefined) return undefined;
  const entries = Object.entries(byKey).toSorted(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? undefined
    : Object.fromEntries(entries.map(([key, counts]) => [key, tokenCountFields(counts)]));
}

export interface BuildMachineOptions {
  /** Keep the working directories of work with no remote, for matching `--dir` on this machine. Never synced. */
  includeLocalDirs?: boolean;
}

export function buildMachineData(
  machineId: string,
  allProviders: Record<string, DayMap>,
  options: BuildMachineOptions = {},
): MachineFile {
  const days: MachineFile['days'] = {};
  for (const [providerKey, dayMap] of Object.entries(allProviders)) {
    for (const [date, day] of dayMap) {
      days[date] ??= {};
      const byModel: Record<string, TokenCounts> = {};
      for (const [model, counts] of Object.entries(day.byModel)) {
        byModel[model] = tokenCountFields(counts);
      }
      const byProject = sortedCounts(day.byProject);
      const byCwd = options.includeLocalDirs ? sortedCounts(day.byCwd) : undefined;
      days[date][providerKey] = {
        byModel,
        totals: tokenCountFields(day),
        ...(byProject && { byProject }),
        ...(byCwd && { byCwd }),
      };
    }
  }
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    hostname: machineId,
    timezone: machineTimezone(),
    dayBucket: 'local',
    lastUpdated: new Date().toISOString(),
    days,
  };
}

export function machineHasData(machine: MachineFile): boolean {
  return Object.keys(machine.days).length > 0;
}

function dayTokens(day: ProviderDay): number {
  return day.totals.inputTokens + day.totals.outputTokens;
}

/**
 * How many persisted provider-days the fresh read would not replace, because
 * it still covers that day but with fewer tokens.
 */
export function ratchetedProviderDays(
  persisted: MachineFile['days'] | null,
  fresh: MachineFile['days'],
): number {
  if (!persisted) return 0;
  let kept = 0;
  for (const [date, providers] of Object.entries(persisted)) {
    for (const [providerKey, persistedDay] of Object.entries(providers)) {
      const freshDay = fresh[date]?.[providerKey];
      if (freshDay !== undefined && dayTokens(freshDay) < dayTokens(persistedDay)) kept++;
    }
  }
  return kept;
}

/**
 * Persisted days overlaid with fresh ones; the larger day wins because tools prune
 * their logs. Keys are sorted so the serialized file is stable.
 */
export function mergePersistedDays(
  persisted: MachineFile['days'] | null,
  fresh: MachineFile['days'],
): MachineFile['days'] {
  const dates = new Set([...Object.keys(persisted ?? {}), ...Object.keys(fresh)]);
  const days: MachineFile['days'] = {};
  for (const date of [...dates].toSorted()) {
    const providers: Record<string, ProviderDay> = { ...persisted?.[date] };
    for (const [providerKey, freshDay] of Object.entries(fresh[date] ?? {})) {
      const persistedDay = providers[providerKey];
      // An equal day keeps its compacted form, so fresh logs do not undo it on every sync.
      const isUnchangedCompacted =
        persistedDay !== undefined &&
        isCompactedDay(persistedDay) &&
        dayTokens(freshDay) === dayTokens(persistedDay);
      if (
        persistedDay === undefined ||
        (dayTokens(freshDay) >= dayTokens(persistedDay) && !isUnchangedCompacted)
      ) {
        providers[providerKey] = freshDay;
      } else if (
        isUnchangedCompacted &&
        persistedDay.byProject === undefined &&
        freshDay.byProject !== undefined
      ) {
        providers[providerKey] = { ...persistedDay, byProject: freshDay.byProject }; // Backfill without undoing the compaction.
      }
    }
    days[date] = Object.fromEntries(
      Object.entries(providers).toSorted(([a], [b]) => a.localeCompare(b)),
    );
  }
  return days;
}

/** UTC-12 to UTC+14: the furthest a timezone change can move a message's calendar date. */
const MAX_ZONE_SHIFT_DAYS = 2;

function providerDates(days: MachineFile['days'], providerKey: string): string[] {
  return Object.keys(days)
    .filter((date) => days[date]?.[providerKey] !== undefined)
    .toSorted();
}

function tokensInRange(
  days: MachineFile['days'],
  providerKey: string,
  dates: string[],
  from: string,
  to: string,
): number {
  let tokens = 0;
  for (const date of dates) {
    const day = days[date]?.[providerKey];
    if (day && date >= from && date <= to) tokens += dayTokens(day);
  }
  return tokens;
}

/**
 * The persisted days to merge with after this machine changed timezone. The logs re-bucket
 * messages near midnight onto a neighbouring day, and the per-day ratchet would then count them on
 * both. A provider's days the logs fully explain are dropped so the fresh ones replace them; if the
 * logs hold fewer tokens they were pruned, and the ratchet stays because losing history is worse.
 */
export function rebucketPersistedDays(
  persisted: MachineFile,
  fresh: MachineFile,
): MachineFile['days'] {
  if (
    persisted.timezone === fresh.timezone ||
    persisted.timezone === UNKNOWN_TIMEZONE ||
    persisted.timezone === ''
  ) {
    return persisted.days;
  }
  const providerKeys = new Set(Object.values(persisted.days).flatMap((day) => Object.keys(day)));
  const dropFrom = new Map<string, string>();
  for (const providerKey of providerKeys) {
    const persistedDates = providerDates(persisted.days, providerKey);
    const freshDates = providerDates(fresh.days, providerKey);
    const [firstPersisted] = persistedDates;
    const [firstFresh] = freshDates;
    const lastPersisted = persistedDates.at(-1);
    if (firstPersisted === undefined || firstFresh === undefined || lastPersisted === undefined) {
      continue;
    }
    // Older history means the oldest logged day may be partial, so it keeps the ratchet too.
    const earliest = firstPersisted < firstFresh ? firstPersisted : firstFresh;
    const from =
      earliest < shiftDate(firstFresh, -MAX_ZONE_SHIFT_DAYS) ? shiftDate(firstFresh, 1) : earliest;
    const to = shiftDate(lastPersisted, MAX_ZONE_SHIFT_DAYS);
    const persistedTokens = tokensInRange(persisted.days, providerKey, persistedDates, from, to);
    const freshTokens = tokensInRange(fresh.days, providerKey, freshDates, from, to);
    if (freshTokens >= persistedTokens) dropFrom.set(providerKey, from);
  }
  if (dropFrom.size === 0) return persisted.days;

  const days: MachineFile['days'] = {};
  for (const [date, providers] of Object.entries(persisted.days)) {
    const kept = Object.entries(providers).filter(([providerKey]) => {
      const from = dropFrom.get(providerKey);
      return from === undefined || date < from;
    });
    if (kept.length > 0) days[date] = Object.fromEntries(kept);
  }
  return days;
}

/** The stable order a machine file is written in. */
export function canonicalDays(days: MachineFile['days']): MachineFile['days'] {
  return mergePersistedDays(days, {});
}

/** What a write path stores for this machine: the logs over what is persisted, then the compaction setting. */
export function outgoingDays(
  persisted: MachineFile['days'] | null,
  fresh: MachineFile['days'],
  compactAfterDays: number | undefined,
  today: string,
): MachineFile['days'] {
  const merged = mergePersistedDays(persisted, fresh);
  return compactAfterDays === undefined ? merged : compactDays(merged, compactAfterDays, today);
}

/**
 * Read every synced provider's local logs into a `{ providerKey: DayMap }` map,
 * in parallel. Driven by the registry, so a new synced provider is picked up
 * without touching this function.
 */
export async function readLocalProviderMaps(
  fallbacks?: FallbackCollector,
  providers?: readonly string[],
): Promise<Record<string, DayMap>> {
  const entries = await Promise.all(
    syncedProviders()
      .filter((provider) => !providers || providers.includes(provider.descriptor.key))
      .map(
        async (provider) =>
          [provider.descriptor.key, await provider.reader.readData(fallbacks)] as const,
      ),
  );
  return Object.fromEntries(entries);
}

export async function buildLocalMachineFile(
  machineId: string,
  fallbacks?: FallbackCollector,
  providers?: readonly string[],
  options?: BuildMachineOptions,
): Promise<MachineFile> {
  const maps = await readLocalProviderMaps(fallbacks, providers);
  return buildMachineData(machineId, maps, options);
}
