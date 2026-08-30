import type { FallbackCollector } from '../pricing/fallback.js';
import { syncedProviders } from '../providers/index.js';
import type { DayMap, MachineFile, ProviderDay, TokenCounts } from './types.js';

function tokenCountFields(counts: TokenCounts): TokenCounts {
  return {
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    ...(counts.rawInputTokens !== undefined && { rawInputTokens: counts.rawInputTokens }),
    ...(counts.cachedInputTokens !== undefined && { cachedInputTokens: counts.cachedInputTokens }),
    ...(counts.cacheCreationInputTokens !== undefined && {
      cacheCreationInputTokens: counts.cacheCreationInputTokens,
    }),
    ...(counts.costUSD !== undefined && { costUSD: counts.costUSD }),
  };
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
  return { hostname: machineId, lastUpdated: new Date().toISOString(), days };
}

export function machineHasData(machine: MachineFile): boolean {
  return Object.keys(machine.days).length > 0;
}

function dayTokens(day: ProviderDay): number {
  return day.totals.inputTokens + day.totals.outputTokens;
}

/**
 * Union of the persisted days and the freshly read ones, preferring fresh data
 * for any (date, provider) it covers — unless the persisted record holds more
 * tokens, which means the local logs have been pruned out from under it.
 *
 * The tools that write the local logs prune them (Claude Code trims transcripts
 * after ~30 days), so for older dates the synced file is the only remaining
 * record. Replacing it wholesale with what the local logs still show would
 * delete that history permanently on the next push.
 *
 * Pruning removes one session file at a time, so the oldest date the logs still
 * reach is typically covered only in part: fresh has that (date, provider) but
 * with fewer tokens than were synced from it earlier. Taking the larger of the
 * two keeps that boundary day from being ratcheted down on every sync.
 *
 * Date and provider keys are sorted so the serialized file is stable and the
 * caller's change detection does not trip on key ordering alone.
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
      if (persistedDay === undefined || dayTokens(freshDay) >= dayTokens(persistedDay)) {
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
): Promise<Record<string, DayMap>> {
  const entries = await Promise.all(
    syncedProviders().map(async (provider) => {
      if (!provider.reader) {
        throw new Error(`provider ${provider.descriptor.key} is synced but has no reader`);
      }
      return [provider.descriptor.key, await provider.reader.readData(fallbacks)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function buildLocalMachineFile(
  machineId: string,
  fallbacks?: FallbackCollector,
): Promise<MachineFile> {
  const maps = await readLocalProviderMaps(fallbacks);
  return buildMachineData(machineId, maps);
}
