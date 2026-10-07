import { basename } from 'node:path';

import { buildMachineData, machineHasData, mergePersistedDays } from './data/localData.js';
import type { MachineFile } from './data/types.js';
import { commitDataChanges, listDataFiles, writeMachineFile } from './git.js';
import { machineDataFilename } from './machineId.js';
import { log } from './output.js';
import { repriceMachineDays } from './pricing/reprice.js';
import { readDataFile } from './store/machineFiles.js';
import { runDataPipeline } from './sync.js';

/** Without costs: per-entry and summed costs differ in the last float bits, which is not a change. */
function tokensJson(days: MachineFile['days']): string {
  return JSON.stringify(days, (key, value: unknown) => (key === 'costUSD' ? undefined : value));
}

/** Null when the file is unreadable and not this machine's to rebuild; `isTouched` when the refresh changed it. */
function loadMachineForRecompute(
  filePath: string,
  isCurrentMachine: boolean,
  localFresh: MachineFile,
  replaceLocal: boolean,
): { machine: MachineFile; isTouched: boolean } | null {
  const machine = readDataFile(filePath, { allowInconsistentCostTotals: true });

  if (!machine) {
    // Only the logs can repair it, and sync refuses to overwrite an unreadable file.
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

  // Days the logs no longer reach stay as persisted and are repriced, not dropped.
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

/** Re-read this machine's logs, reprice every synced machine file, and push what changed. */
export function recomputeCosts(options: RecomputeCostsOptions = {}): Promise<void> {
  return runDataPipeline({ pull: true }, async ({ machineId, fallbacks, readLocalMaps }) => {
    const files = listDataFiles();
    if (files.length === 0) {
      log.info('No synced data files found.');
      return;
    }

    const localFresh = buildMachineData(machineId, await readLocalMaps());

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

    if (await commitDataChanges(`recompute: refresh costs at ${new Date().toISOString()}`)) {
      log.info('Pushed updated costs.');
    }
  });
}
