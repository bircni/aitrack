import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { loadConfig, resolveMachineId } from 'aitrack-lib/config';
import { reportMachineFileDiagnostics } from 'aitrack-lib/data/diagnostics';
import {
  buildMachineData,
  machineHasData,
  mergePersistedDays,
  readLocalProviderMaps,
} from 'aitrack-lib/data/localData';
import { REPO_NOT_CLONED_MESSAGE } from 'aitrack-lib/data/messages';
import type { MachineFile } from 'aitrack-lib/data/types';
import { checkRawMachineFile } from 'aitrack-lib/data/validate';
import {
  commitDataChanges,
  isCloned,
  listDataFiles,
  pull,
  writeMachineFile,
} from 'aitrack-lib/git';
import { machineDataFilename } from 'aitrack-lib/machineId';
import { log } from 'aitrack-lib/output';
import { createFallbackCollector, reportFallbackPricing } from 'aitrack-lib/pricing/fallback';
import { repriceMachineDays } from 'aitrack-lib/pricing/reprice';
import { syncPricingPack } from 'aitrack-lib/pricing/syncPack';

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

/**
 * The machine file to reprice, refreshed from the local logs when it is this
 * machine's. Null when the file cannot be read and is not ours to rebuild;
 * `isTouched` reports whether the refresh alone already changed it.
 */
function loadMachineForRecompute(
  filePath: string,
  isCurrentMachine: boolean,
  localFresh: MachineFile,
  replaceLocal: boolean,
): { machine: MachineFile; isTouched: boolean } | null {
  const raw = readFileSync(filePath, 'utf8');
  const checked = checkRawMachineFile(raw, filePath, { allowInconsistentCostTotals: true });
  reportMachineFileDiagnostics(checked.diagnostics);
  const machine = checked.machine;

  if (!machine) {
    // The diagnostics above already said why. Only the current machine can be
    // repaired — the local logs are its source of truth — and this is the one
    // command that can do it: sync refuses to overwrite a file it cannot read.
    if (!isCurrentMachine || !machineHasData(localFresh)) return null;
    log.warn(`  Rebuilding ${basename(filePath)} from the local logs.`);
    return {
      machine: { ...localFresh, days: mergePersistedDays(null, localFresh.days) },
      isTouched: true,
    };
  }

  if (isCurrentMachine && replaceLocal) {
    if (!machineHasData(localFresh)) {
      log.warn(
        'Refusing to replace this machine from the local logs — they have no usage. The synced file was left as it is.',
      );
      return { machine, isTouched: false };
    }
    const replaced = mergePersistedDays(null, localFresh.days);
    return {
      machine: { ...machine, days: replaced },
      isTouched: tokensJson(replaced) !== tokensJson(machine.days),
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

export interface RecomputeCostsOptions {
  /**
   * Rebuild this machine from the local logs, including days the logs now
   * report with fewer tokens, and drop days the logs no longer cover.
   */
  replaceLocal?: boolean;
}

export async function recomputeCostsCommand(options: RecomputeCostsOptions = {}): Promise<void> {
  const fallbacks = createFallbackCollector();
  const config = loadConfig();
  const machineId = resolveMachineId(config);

  if (!isCloned()) {
    throw new Error(REPO_NOT_CLONED_MESSAGE);
  }

  log.info('Pulling latest from remote...');
  await pull();
  await syncPricingPack();

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
      Boolean(options.replaceLocal),
    );
    if (!loaded) continue;

    const repriced = repriceMachineDays(loaded.machine.days, fallbacks);
    legacySkipped += repriced.legacySkipped;
    if (!loaded.isTouched && !repriced.isTouched) continue;

    loaded.machine.lastUpdated = new Date().toISOString();
    writeMachineFile(filePath, loaded.machine);
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

  const isPushed = await commitDataChanges(
    `recompute: refresh costs at ${new Date().toISOString()}`,
  );
  if (!isPushed) {
    log.info('No file actually changed on disk — pricing already current.');
    return;
  }
  log.info('Pushed updated costs.');
}
