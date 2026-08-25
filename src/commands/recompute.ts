import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { loadConfig, resolveMachineId } from '../config.js';
import {
  buildMachineData,
  machineHasData,
  mergePersistedDays,
  readLocalProviderMaps,
} from '../data/localData.js';
import { REPO_NOT_CLONED_MESSAGE } from '../data/messages.js';
import type { MachineFile, ProviderDay } from '../data/types.js';
import { approximatelyEqual, parseMachineFile } from '../data/validate.js';
import { SYNCED_PROVIDERS } from '../display/providers.js';
import { commitDataChanges, isCloned, listDataFiles } from '../git.js';
import { machineDataFilename } from '../machineId.js';
import { log } from '../output.js';
import {
  createFallbackCollector,
  type FallbackCollector,
  reportFallbackPricing,
} from '../pricing/fallback.js';
import { resolveModelCost } from '../pricing/resolve.js';

/**
 * Days serialized without their costs, for change detection.
 *
 * The readers accumulate a cost per JSONL entry while the repricing loop below
 * derives it once from the summed tokens. Those agree mathematically but not in
 * the last float bits, so comparing costs here would mark an already normalized
 * file as changed on every run. Costs are the loop's business; the merge only
 * has to notice a token-level difference.
 */
function tokensJson(days: MachineFile['days']): string {
  return JSON.stringify(days, (key, value: unknown) => (key === 'costUSD' ? undefined : value));
}

interface RepriceResult {
  /** Whether any stored cost was replaced. */
  isTouched: boolean;
  /** Claude model-days left alone because they predate the cache breakdown. */
  legacySkipped: number;
}

/**
 * Recompute every model cost in one provider-day and re-derive the day total.
 *
 * Costs are only rewritten when they differ beyond float noise: the readers sum
 * a cost per JSONL entry while this derives it from the summed tokens, so an
 * unchanged day would otherwise look repriced on every run.
 */
function repriceProviderDay(
  providerKey: string,
  date: string,
  providerDay: ProviderDay,
  fallbacks: FallbackCollector,
): RepriceResult {
  let dayTotal = 0;
  let modelCount = 0;
  let isCostComplete = true;
  let isTouched = false;
  let legacySkipped = 0;

  for (const [model, counts] of Object.entries(providerDay.byModel)) {
    modelCount++;
    const cost = resolveModelCost(providerKey, model, counts, date, 'recompute', fallbacks);
    if (cost === undefined) {
      if (counts.costUSD === undefined) {
        isCostComplete = false;
      } else {
        dayTotal += counts.costUSD;
        if (providerKey === 'claude_code') legacySkipped++;
      }
      continue;
    }
    if (counts.costUSD === undefined || !approximatelyEqual(counts.costUSD, cost)) {
      counts.costUSD = cost;
      isTouched = true;
    }
    dayTotal += cost;
  }

  // A day total is only safe to re-derive once every model in it has a cost.
  if (
    modelCount > 0 &&
    isCostComplete &&
    (providerDay.totals.costUSD === undefined ||
      !approximatelyEqual(providerDay.totals.costUSD, dayTotal))
  ) {
    providerDay.totals.costUSD = dayTotal;
    isTouched = true;
  }

  return { isTouched, legacySkipped };
}

/** Reprice every synced provider-day in a machine file, in place. */
function repriceMachineDays(
  days: MachineFile['days'],
  fallbacks: FallbackCollector,
): RepriceResult {
  let isTouched = false;
  let legacySkipped = 0;

  for (const [date, providers] of Object.entries(days)) {
    for (const providerKey of SYNCED_PROVIDERS) {
      const providerDay = providers[providerKey];
      if (!providerDay) continue;
      const result = repriceProviderDay(providerKey, date, providerDay, fallbacks);
      isTouched ||= result.isTouched;
      legacySkipped += result.legacySkipped;
    }
  }

  return { isTouched, legacySkipped };
}

/**
 * The machine file to reprice, refreshed from the local logs when it is this
 * machine's. Null when the file cannot be read and is not ours to rebuild;
 * `isTouched` reports whether the refresh alone already changed it.
 */
function loadMachineForRecompute(
  filePath: string,
  isCurrentMachine: boolean,
  localFresh: MachineFile,
): { machine: MachineFile; isTouched: boolean } | null {
  const raw = readFileSync(filePath, 'utf8');
  const machine = parseMachineFile(raw, filePath, { allowInconsistentCostTotals: true });

  if (!machine) {
    // parseMachineFile already warned why. Only the current machine can be
    // repaired — the local logs are its source of truth — and this is the one
    // command that can do it: sync refuses to overwrite a file it cannot read.
    if (!isCurrentMachine || !machineHasData(localFresh)) return null;
    log.warn(`  Rebuilding ${basename(filePath)} from the local logs.`);
    return {
      machine: { ...localFresh, days: mergePersistedDays(null, localFresh.days) },
      isTouched: true,
    };
  }

  if (!isCurrentMachine || !machineHasData(localFresh)) return { machine, isTouched: false };

  // Refresh the current machine's days from the local logs before repricing.
  // Days the logs no longer reach stay as persisted and are repriced like any
  // other machine's, rather than being dropped.
  const refreshed = mergePersistedDays(machine.days, localFresh.days);
  const isTouched = tokensJson(refreshed) !== tokensJson(machine.days);
  machine.days = refreshed;
  return { machine, isTouched };
}

function reportLegacySkipped(legacySkipped: number, state: 'skipped' | 'left unchanged'): void {
  if (legacySkipped === 0) return;
  log.info(
    `  ${String(legacySkipped)} model-day(s) ${state} (legacy data without cache breakdown — re-sync from that machine).`,
  );
}

export async function recomputeCostsCommand(): Promise<void> {
  const fallbacks = createFallbackCollector();
  const config = loadConfig();
  const machineId = resolveMachineId(config);

  if (!isCloned()) {
    throw new Error(REPO_NOT_CLONED_MESSAGE);
  }

  const files = listDataFiles();
  if (files.length === 0) {
    log.info('No synced data files found.');
    return;
  }

  const localFresh = buildMachineData(machineId, await readLocalProviderMaps(fallbacks));

  let changed = 0;
  let legacySkipped = 0;

  for (const filePath of files) {
    const loaded = loadMachineForRecompute(
      filePath,
      basename(filePath) === machineDataFilename(machineId),
      localFresh,
    );
    if (!loaded) continue;

    const repriced = repriceMachineDays(loaded.machine.days, fallbacks);
    legacySkipped += repriced.legacySkipped;
    if (!loaded.isTouched && !repriced.isTouched) continue;

    loaded.machine.lastUpdated = new Date().toISOString();
    writeFileSync(filePath, JSON.stringify(loaded.machine, null, 2), 'utf8');
    changed++;
  }

  if (changed === 0) {
    log.info('Nothing to recompute — costs are already current.');
    reportLegacySkipped(legacySkipped, 'skipped');
    return;
  }

  log.info(`Recomputed costs in ${String(changed)} file(s).`);
  reportLegacySkipped(legacySkipped, 'left unchanged');

  reportFallbackPricing(fallbacks);

  const isPushed = commitDataChanges(`recompute: refresh costs at ${new Date().toISOString()}`);
  if (!isPushed) {
    log.info('No file actually changed on disk — pricing already current.');
    return;
  }
  log.info('Pushed updated costs.');
}
