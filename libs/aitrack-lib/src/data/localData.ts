import { OPTIONAL_TOKEN_NUMBER_FIELDS } from '../constants.js';
import type { FallbackCollector } from '../pricing/fallback.js';
import { syncedProviders } from '../providers/index.js';
import { machineTimezone } from '../timezone.js';
import { isCompactedDay } from './compact.js';
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

export function buildMachineData(
  machineId: string,
  allProviders: Record<string, DayMap>,
): MachineFile {
  const days: MachineFile['days'] = {};
  for (const [providerKey, dayMap] of Object.entries(allProviders)) {
    for (const [date, day] of dayMap) {
      days[date] ??= {};
      const byModel: Record<string, TokenCounts> = {};
      for (const [model, counts] of Object.entries(day.byModel)) {
        byModel[model] = tokenCountFields(counts);
      }
      days[date][providerKey] = {
        byModel,
        totals: tokenCountFields(day),
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
      }
    }
    days[date] = Object.fromEntries(
      Object.entries(providers).toSorted(([a], [b]) => a.localeCompare(b)),
    );
  }
  return days;
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
): Promise<MachineFile> {
  const maps = await readLocalProviderMaps(fallbacks, providers);
  return buildMachineData(machineId, maps);
}
