import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, resolveMachineId } from './config.js';
import { compactDays } from './data/compact.js';
import { reportMachineFileDiagnostics } from './data/diagnostics.js';
import {
  buildMachineData,
  mergePersistedDays,
  ratchetedProviderDays,
  readLocalProviderMaps,
} from './data/localData.js';
import { REPO_NOT_CLONED_MESSAGE } from './data/messages.js';
import type { DayMap, MachineFile } from './data/types.js';
import { todayString } from './data/usagePeriods.js';
import { checkRawMachineFile } from './data/validate.js';
import { isMissingPathError } from './errors.js';
import {
  commitAndPush,
  type GitOptions,
  hasMachineDataChanges,
  hasUnpushedCommits,
  isCloned,
  LOCAL_REPO,
  pull,
  pushPendingCommits,
  removePendingMachineFile,
  withRepoLock,
  writeMachineFile,
} from './git.js';
import { machineDataFilename } from './machineId.js';
import { log } from './output.js';
import {
  createFallbackCollector,
  type FallbackCollector,
  reportFallbackPricing,
} from './pricing/fallback.js';
import { recordPricingFallbacks } from './pricing/scan.js';
import { syncPricingPack } from './pricing/syncPack.js';
import { syncedProviders } from './providers/index.js';
import {
  ENCRYPTION_PASSPHRASE_ENV,
  encryptionPassphrase,
  isEncryptedRaw,
} from './store/encryption.js';
import { missingPassphraseMessage } from './store/machineFiles.js';

export interface SyncDataOptions extends GitOptions {
  dryRun?: boolean;
  /** Fail when commits are still waiting to be pushed after the sync. */
  verify?: boolean;
}

export interface SyncResult {
  /** Built from the local logs, for a caller that needs it too. */
  machine: MachineFile;
  /** The outcome in one line, as the CLI logs it. */
  message: string;
  /** Whether this run pushed commits to the remote. */
  pushed: boolean;
  /** Days in the machine file after the run. */
  days: number;
}

const NO_CHANGES_MESSAGE = 'No changes to push — data is already up to date.';

function pushedMessage(host: string, syncedDays: number): string {
  return `Done! Pushed data/${host}.json (${String(syncedDays)} days)`;
}

/** Also commits a rename-only machineId change and pushes a commit whose earlier push failed. */
async function pushMachineData(host: string, options: GitOptions): Promise<boolean> {
  return (
    ((await hasMachineDataChanges(host)) && (await commitAndPush(host, options))) ||
    pushPendingCommits(options)
  );
}

export interface DataRun {
  machineId: string;
  fallbacks: FallbackCollector;
  /** The local logs, read once the pricing refresh has settled. */
  readLocalMaps: () => Promise<Record<string, DayMap>>;
}

/** Parses logs outside the repo lock to overlap the wait and pull; one fallback collector per run. */
export async function runDataPipeline<T>(
  options: { pull: boolean; git?: GitOptions },
  step: (run: DataRun) => Promise<T>,
): Promise<T> {
  const config = loadConfig(); // Before the refresh, so an unconfigured machine never contacts GitHub.
  if (!isCloned()) {
    throw new Error(REPO_NOT_CLONED_MESSAGE);
  }
  const fallbacks = createFallbackCollector();
  const localRead = syncPricingPack().then(async () => {
    const maps = await readLocalProviderMaps(fallbacks);
    recordPricingFallbacks(maps, fallbacks); // Cache hits never call the pricer.
    return maps;
  });
  void localRead.catch(() => undefined); // Rejecting before the step awaits it is not unhandled.
  try {
    return await withRepoLock(async () => {
      if (options.pull) {
        log.info('Pulling latest from remote...');
        await pull(options.git);
      }
      return step({
        machineId: resolveMachineId(config),
        fallbacks,
        readLocalMaps: () => localRead,
      });
    });
  } finally {
    await localRead.catch(() => undefined); // Settle it on an early exit too.
    reportFallbackPricing(fallbacks); // Report even when nothing was pushed.
  }
}

/** Returns the local machine file so callers need not re-parse the corpus. */
export async function syncData(options: SyncDataOptions = {}): Promise<SyncResult> {
  const result = await runDataPipeline({ pull: !options.dryRun, git: options }, (run) =>
    pushLocalUsage(options, run),
  );
  if (options.verify && !options.dryRun && (await hasUnpushedCommits())) {
    throw new Error('Sync finished, but commits are still waiting to be pushed to the remote.');
  }
  return result;
}

async function pushLocalUsage(
  options: SyncDataOptions,
  { machineId: host, readLocalMaps }: DataRun,
): Promise<SyncResult> {
  const isDryRun = Boolean(options.dryRun);
  const { encryptData, compactAfterDays } = loadConfig();
  const encrypt = encryptData === true;
  if (encrypt && encryptionPassphrase() === undefined) {
    throw new Error(missingPassphraseMessage());
  }
  const dataFilePath = join(LOCAL_REPO, 'data', machineDataFilename(host));

  log.info('Reading local data...');
  const maps = await readLocalMaps();

  const freshData = buildMachineData(host, maps);
  const done = (message: string, pushed: boolean, days: number): SyncResult => {
    log.info(message);
    return { machine: freshData, message, pushed, days };
  };
  const totalDays = new Set(Object.values(maps).flatMap((map) => [...map.keys()])).size;

  if (totalDays === 0) {
    const isPushed = !isDryRun && (await pushMachineData(host, options));
    return done(
      isPushed
        ? `Done! Pushed machine data migration for ${host}.`
        : `No local data found (${syncedProviders()
            .map((provider) => provider.descriptor.label)
            .join(' or ')}).`,
      isPushed,
      0,
    );
  }

  const sources = syncedProviders()
    .map((provider) => ({
      label: provider.descriptor.label,
      size: maps[provider.descriptor.key]?.size ?? 0,
    }))
    .filter((source) => source.size > 0)
    .map((source) => `${source.label} (${String(source.size)} days)`);
  log.info(`Found: ${sources.join(', ')}`);

  let raw: string | null = null;
  try {
    raw = readFileSync(dataFilePath, 'utf8');
  } catch (error) {
    if (!isMissingPathError(error)) throw error; // Read as empty, it would push the logs over the file.
  }

  let existingDays: MachineFile['days'] | null = null;
  if (raw !== null) {
    const existing = checkRawMachineFile(raw, dataFilePath);
    reportMachineFileDiagnostics(existing.diagnostics);
    // Merging an invalid file as empty would push the loss of its history.
    if (!existing.machine) {
      const fix = isEncryptedRaw(raw)
        ? `  Set ${ENCRYPTION_PASSPHRASE_ENV} to the passphrase the file was encrypted with.`
        : "  Run: npx aitrack recompute-costs   (rebuilds this machine's file from the local logs)";
      throw new Error(
        `Refusing to overwrite invalid data/${machineDataFilename(host)} (see the warning above).\n${fix}`,
      );
    }
    existingDays = existing.machine.days;
  }

  const mergedDays = mergePersistedDays(existingDays, freshData.days);
  const outgoingDays =
    compactAfterDays === undefined
      ? mergedDays
      : compactDays(mergedDays, compactAfterDays, todayString());
  const keptDays = ratchetedProviderDays(existingDays, freshData.days);
  if (keptDays > 0) {
    log.info(
      `Kept ${String(keptDays)} synced day(s) with more tokens than the local logs still show.`,
    );
    log.info(
      '  Run: npx aitrack recompute-costs --replace-local   to rebuild this machine from the logs.',
    );
  }
  const outgoingData: MachineFile = { ...freshData, days: outgoingDays };
  const syncedDays = Object.keys(outgoingDays).length;
  const normalizedExisting = existingDays === null ? null : mergePersistedDays(existingDays, {}); // Same key order as outgoing.

  // Usage only: lastUpdated and the schema header alone are not worth a commit.
  const isEncryptionChange = raw !== null && isEncryptedRaw(raw) !== encrypt;
  if (!isEncryptionChange && JSON.stringify(normalizedExisting) === JSON.stringify(outgoingDays)) {
    let isPushed = false;
    if (!isDryRun) {
      removePendingMachineFile(host);
      isPushed = await pushMachineData(host, options);
    }
    return done(
      isPushed ? pushedMessage(host, syncedDays) : NO_CHANGES_MESSAGE,
      isPushed,
      syncedDays,
    );
  }

  if (isDryRun) {
    const action = existingDays === null ? 'create' : 'update';
    return done(
      `Dry run: would ${action} data/${host}.json (${String(syncedDays)} days). No changes written.`,
      false,
      syncedDays,
    );
  }

  writeMachineFile(dataFilePath, outgoingData, encrypt);
  removePendingMachineFile(host);

  const isPushed = await commitAndPush(host, options);
  return done(
    isPushed ? pushedMessage(host, syncedDays) : NO_CHANGES_MESSAGE,
    isPushed,
    syncedDays,
  );
}
