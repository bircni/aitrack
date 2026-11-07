import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { compactDays } from './data/compact.js';
import { reportMachineFileDiagnostics } from './data/diagnostics.js';
import {
  buildMachineData,
  canonicalDays,
  machineHasData,
  mergePersistedDays,
} from './data/localData.js';
import type { MachineFile } from './data/types.js';
import { todayString } from './data/usagePeriods.js';
import { checkRawMachineFile, type MachineFileCheck } from './data/validate.js';
import { commitDataChanges, listDataFiles, readCommittedFile, writeMachineFile } from './git.js';
import { machineDataFilename } from './machineId.js';
import { log } from './output.js';
import { repriceMachineDays } from './pricing/reprice.js';
import { encryptionPassphrase } from './store/encryption.js';
import { missingPassphraseMessage } from './store/machineFiles.js';
import { runDataPipeline } from './sync.js';

/** Without costs: per-entry and summed costs differ in the last float bits, which is not a change. */
function tokensJson(days: MachineFile['days']): string {
  return JSON.stringify(days, (key, value: unknown) => (key === 'costUSD' ? undefined : value));
}

function checkForRecompute(raw: string, filePath: string): MachineFileCheck {
  const checked = checkRawMachineFile(raw, filePath, { allowInconsistentCostTotals: true });
  reportMachineFileDiagnostics(checked.diagnostics);
  return checked;
}

interface LocalRebuild {
  fresh: MachineFile;
  replaceLocal: boolean;
  merged: (persisted: MachineFile['days'] | null) => MachineFile['days'];
}

interface LoadedMachine {
  machine: MachineFile;
  /** Whether the refresh changed it, before any repricing. */
  isTouched: boolean;
  /** Rebuilt for this machine, so it takes the compaction setting once repriced: a compacted day has no models left to price. */
  isOwnRebuild: boolean;
}

function rebuildFromLogs({ fresh, merged }: LocalRebuild): LoadedMachine {
  return { machine: { ...fresh, days: merged(null) }, isTouched: true, isOwnRebuild: true };
}

/**
 * This machine's file could not be read. Only a corrupt one may be rewritten: a newer schema or a
 * file this passphrase cannot open is healthy, and its older days may exist nowhere else.
 */
async function repairOwnFile(
  filePath: string,
  check: MachineFileCheck,
  local: LocalRebuild,
): Promise<LoadedMachine | null> {
  const hasLogs = machineHasData(local.fresh);
  if (local.replaceLocal) {
    if (check.failure === 'future-schema' || !hasLogs) return null;
    log.warn(`  Replacing unreadable ${basename(filePath)} with the local logs, as requested.`);
    return rebuildFromLogs(local);
  }
  if (check.failure !== 'corrupt') {
    log.warn(
      `  Left ${basename(filePath)} as it is: nothing was lost, it is only unreadable here.`,
    );
    return null;
  }

  const committedRaw = await readCommittedFile(`data/${basename(filePath)}`);
  const committed = committedRaw === null ? null : checkForRecompute(committedRaw, filePath);
  if (committed?.machine) {
    log.warn(`  Restoring ${basename(filePath)} from its last commit.`);
    return {
      machine: { ...committed.machine, days: local.merged(committed.machine.days) },
      isTouched: true,
      isOwnRebuild: true,
    };
  }
  if ((committed !== null && committed.failure !== 'corrupt') || !hasLogs) return null;
  log.warn(
    `  Rebuilding ${basename(filePath)} from the local logs. Days they no longer cover remain only in the repo's git history.`,
  );
  return rebuildFromLogs(local);
}

function refreshOwnFile(machine: MachineFile, local: LocalRebuild): LoadedMachine {
  if (!machineHasData(local.fresh)) {
    if (local.replaceLocal) {
      log.warn(
        'Refusing to replace this machine from the local logs — they have no usage. The synced file was left as it is.',
      );
    }
    return { machine, isTouched: false, isOwnRebuild: false };
  }
  // Days the logs no longer reach stay as persisted and are repriced, not dropped.
  const days = local.merged(local.replaceLocal ? null : machine.days);
  if (local.replaceLocal) {
    const dropped = Object.keys(machine.days).filter((date) => days[date] === undefined).length;
    if (dropped > 0)
      log.warn(`Dropping ${String(dropped)} synced day(s) the logs no longer cover.`);
  }
  return {
    machine: { ...machine, days },
    isTouched: tokensJson(days) !== tokensJson(canonicalDays(machine.days)),
    isOwnRebuild: true,
  };
}

interface PendingWrite {
  filePath: string;
  machine: MachineFile;
  encrypt: boolean;
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
   * report with fewer tokens, and drop days the logs no longer cover. The one
   * way past a file no passphrase can open any more.
   */
  replaceLocal?: boolean;
}

export interface RecomputeResult {
  /** Machine files rewritten. */
  changed: number;
  /** Whether the rewritten files were pushed. */
  pushed: boolean;
}

/** Re-read this machine's logs, reprice every synced machine file, and push what changed. */
export function recomputeCosts(options: RecomputeCostsOptions = {}): Promise<RecomputeResult> {
  return runDataPipeline(
    { pull: true },
    async ({ config, machineId, fallbacks, readLocalMaps }) => {
      const files = listDataFiles();
      if (files.length === 0) {
        log.info('No synced data files found.');
        return { changed: 0, pushed: false };
      }

      const fresh = buildMachineData(machineId, await readLocalMaps());
      const local: LocalRebuild = {
        fresh,
        replaceLocal: Boolean(options.replaceLocal),
        merged: (persisted) => mergePersistedDays(persisted, fresh.days),
      };

      const pending: PendingWrite[] = [];
      let legacySkipped = 0;

      for (const filePath of files) {
        const isCurrentMachine = basename(filePath) === machineDataFilename(machineId);
        const check = checkForRecompute(readFileSync(filePath, 'utf8'), filePath);
        let loaded: LoadedMachine | null;
        if (!isCurrentMachine) {
          loaded = check.machine && {
            machine: check.machine,
            isTouched: false,
            isOwnRebuild: false,
          };
        } else if (check.machine) {
          loaded = refreshOwnFile(check.machine, local);
        } else {
          loaded = await repairOwnFile(filePath, check, local);
        }
        if (!loaded) continue; // Another machine's unreadable file: the local logs are not its history.

        const repriced = repriceMachineDays(loaded.machine.days, fallbacks);
        legacySkipped += repriced.legacySkipped;
        const repricedDays = loaded.machine.days;
        const days =
          loaded.isOwnRebuild && config.compactAfterDays !== undefined
            ? compactDays(repricedDays, config.compactAfterDays, todayString())
            : repricedDays;
        const isCompacted = tokensJson(days) !== tokensJson(repricedDays);
        if (!loaded.isTouched && !repriced.isTouched && !isCompacted) continue;

        pending.push({
          filePath,
          machine: { ...loaded.machine, days, lastUpdated: new Date().toISOString() },
          // Another machine's file keeps its owner's choice, or this would publish encrypted data as plaintext.
          encrypt: isCurrentMachine ? config.encryptData === true : check.encrypted === true,
        });
      }

      const changed = pending.length;
      if (changed === 0) {
        log.info('Nothing to recompute — costs are already current.');
        reportLegacySkipped(legacySkipped, 'skipped');
        return { changed: 0, pushed: false };
      }

      // Before the first write: a file rewritten and left uncommitted by a stop here would block later pulls.
      if (pending.some(({ encrypt }) => encrypt) && encryptionPassphrase() === undefined) {
        throw new Error(missingPassphraseMessage());
      }
      for (const { filePath, machine, encrypt } of pending) {
        writeMachineFile(filePath, machine, encrypt, { allowInconsistentCostTotals: true });
      }

      log.info(`Recomputed costs in ${String(changed)} file(s).`);
      reportLegacySkipped(legacySkipped, 'left unchanged');

      const pushed = await commitDataChanges(
        `recompute: refresh costs at ${new Date().toISOString()}`,
        pending.map(({ filePath }) => `data/${basename(filePath)}`),
      );
      if (pushed) log.info('Pushed updated costs.');
      return { changed, pushed };
    },
  );
}
