import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, resolveMachineId } from './config.js';
import { reportMachineFileDiagnostics } from './data/diagnostics.js';
import {
  buildMachineData,
  mergePersistedDays,
  ratchetedProviderDays,
  readLocalProviderMaps,
} from './data/localData.js';
import { REPO_NOT_CLONED_MESSAGE } from './data/messages.js';
import type { MachineFile } from './data/types.js';
import { checkRawMachineFile } from './data/validate.js';
import {
  commitAndPush,
  hasMachineDataChanges,
  isCloned,
  LOCAL_REPO,
  pull,
  pushPendingCommits,
  removePendingMachineFile,
  writeMachineFile,
} from './git.js';
import type { GitOptions } from './git/exec.js';
import { withRepoLock } from './git/lock.js';
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

export interface SyncDataOptions extends GitOptions {
  dryRun?: boolean;
}

export interface SyncResult {
  /** Built from the local logs, for a caller that needs it too. */
  machine: MachineFile;
  /** The outcome in one line, as the CLI logs it. */
  message: string;
}

const NO_CHANGES_MESSAGE = 'No changes to push — data is already up to date.';

function pushedMessage(host: string, syncedDays: number): string {
  return `Done! Pushed data/${host}.json (${String(syncedDays)} days)`;
}

/**
 * Commit and push this machine's data file, reporting whether anything reached
 * the remote.
 *
 * A machineId change shows up as a pending git rename rather than a content
 * change, so it needs the same commit path as an update. pushPendingCommits
 * then covers a commit whose earlier push failed: the working tree is clean
 * again, so nothing else here would notice it never landed.
 */
async function pushMachineData(host: string, options: GitOptions): Promise<boolean> {
  return (
    ((await hasMachineDataChanges(host)) && (await commitAndPush(host, options))) ||
    pushPendingCommits(options)
  );
}

/**
 * Push this machine's usage data. Returns the machine file built from the local
 * logs, so a caller that needs it as well does not have to parse the whole
 * JSONL corpus a second time.
 */
export async function syncData(options: SyncDataOptions = {}): Promise<SyncResult> {
  // One collector per run, so a long-lived process never carries one run's
  // models into the next.
  const fallbacks = createFallbackCollector();
  try {
    await syncPricingPack();
    return await withRepoLock(() => pushLocalUsage(options, fallbacks));
  } finally {
    // Fallback hits accumulate while the logs are read, so they exist however
    // the push turns out. Reporting them only after a successful push hid the
    // warning from every already-up-to-date run.
    reportFallbackPricing(fallbacks);
  }
}

async function pushLocalUsage(
  options: SyncDataOptions,
  fallbacks: FallbackCollector,
): Promise<SyncResult> {
  const config = loadConfig();
  const isDryRun = Boolean(options.dryRun);

  if (!isCloned()) {
    throw new Error(REPO_NOT_CLONED_MESSAGE);
  }

  if (!isDryRun) {
    log.info('Pulling latest from remote...');
    await pull(options);
  }

  const host = resolveMachineId(config);
  const dataFilePath = join(LOCAL_REPO, 'data', machineDataFilename(host));

  // Cursor usage is loaded locally by report/display commands; it is never written to git.
  log.info('Reading local data...');
  const maps = await readLocalProviderMaps(fallbacks);
  // Cache hits never call the pricer, so scan the maps that were actually loaded.
  recordPricingFallbacks(maps, fallbacks);

  const freshData = buildMachineData(host, maps);
  const done = (message: string): SyncResult => {
    log.info(message);
    return { machine: freshData, message };
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

  // Only write if the usage data changed — avoids a spurious commit on every run
  // (lastUpdated would otherwise always make the file dirty).
  let raw: string | null = null;
  try {
    raw = readFileSync(dataFilePath, 'utf8');
  } catch (error) {
    // Anything other than "not synced yet" is a real read failure, and treating
    // it as an empty file would push the local logs over whatever is there.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // The check also returns a null machine for a file that exists but is invalid.
  // Merging against null there would silently replace the synced history with
  // whatever the local logs still reach and push the loss.
  let existingDays: MachineFile['days'] | null = null;
  if (raw !== null) {
    const existing = checkRawMachineFile(raw, dataFilePath);
    reportMachineFileDiagnostics(existing.diagnostics);
    if (!existing.machine) {
      throw new Error(
        `Refusing to overwrite invalid data/${machineDataFilename(host)} (see the warning above).\n` +
          "  Run: npx aitrack recompute-costs   (rebuilds this machine's file from the local logs)",
      );
    }
    existingDays = existing.machine.days;
  }

  // Keep days the local logs no longer cover — see mergePersistedDays.
  const outgoingDays = mergePersistedDays(existingDays, freshData.days);
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
  // Normalize the persisted side through the same ordering so a file that is
  // already up to date does not look changed purely because of key order.
  const normalizedExisting = existingDays === null ? null : mergePersistedDays(existingDays, {});

  // Usage only. The schema header is metadata nothing reads, so a file that is
  // otherwise up to date is not worth a commit just to stamp it — it lands on
  // this machine's next real change.
  if (JSON.stringify(normalizedExisting) === JSON.stringify(outgoingDays)) {
    let isPushed = false;
    if (!isDryRun) {
      removePendingMachineFile(host);
      isPushed = await pushMachineData(host, options);
    }
    return done(isPushed ? pushedMessage(host, syncedDays) : NO_CHANGES_MESSAGE);
  }

  if (isDryRun) {
    const action = existingDays === null ? 'create' : 'update';
    return done(
      `Dry run: would ${action} data/${host}.json (${String(syncedDays)} days). No changes written.`,
    );
  }

  writeMachineFile(dataFilePath, outgoingData);
  removePendingMachineFile(host);

  return done(
    (await commitAndPush(host, options)) ? pushedMessage(host, syncedDays) : NO_CHANGES_MESSAGE,
  );
}
