import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, resolveMachineId } from 'aitrack-lib/config';
import { reportMachineFileDiagnostics } from 'aitrack-lib/data/diagnostics';
import {
  buildMachineData,
  mergePersistedDays,
  readLocalProviderMaps,
} from 'aitrack-lib/data/localData';
import { REPO_NOT_CLONED_MESSAGE } from 'aitrack-lib/data/messages';
import type { MachineFile } from 'aitrack-lib/data/types';
import { checkRawMachineFile } from 'aitrack-lib/data/validate';
import {
  commitAndPush,
  hasMachineDataChanges,
  isCloned,
  LOCAL_REPO,
  pull,
  pushPendingCommits,
  removePendingMachineFile,
} from 'aitrack-lib/git';
import { machineDataFilename } from 'aitrack-lib/machineId';
import { log } from 'aitrack-lib/output';
import {
  createFallbackCollector,
  type FallbackCollector,
  reportFallbackPricing,
} from 'aitrack-lib/pricing/fallback';
import { syncedProviders } from 'aitrack-lib/providers/index';

export interface SyncDataOptions {
  dryRun?: boolean;
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
function pushMachineData(host: string): boolean {
  return (hasMachineDataChanges(host) && commitAndPush(host)) || pushPendingCommits();
}

/**
 * Push this machine's usage data. Returns the machine file built from the local
 * logs, so a caller that needs it as well does not have to parse the whole
 * JSONL corpus a second time.
 */
export async function syncData(options: SyncDataOptions = {}): Promise<MachineFile> {
  // One collector per run, so a long-lived process never carries one run's
  // models into the next.
  const fallbacks = createFallbackCollector();
  try {
    return await pushLocalUsage(options, fallbacks);
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
): Promise<MachineFile> {
  const config = loadConfig();
  const isDryRun = Boolean(options.dryRun);

  if (!isCloned()) {
    throw new Error(REPO_NOT_CLONED_MESSAGE);
  }

  if (!isDryRun) {
    log.info('Pulling latest from remote...');
    pull();
  }

  const host = resolveMachineId(config);
  const dataDir = join(LOCAL_REPO, 'data');
  const dataFilePath = join(dataDir, machineDataFilename(host));

  // Cursor usage is loaded locally by report/display commands; it is never written to git.
  log.info('Reading local data...');
  const maps = await readLocalProviderMaps(fallbacks);

  const freshData = buildMachineData(host, maps);
  const totalDays = new Set(Object.values(maps).flatMap((map) => [...map.keys()])).size;

  if (totalDays === 0) {
    const isPushed = !isDryRun && pushMachineData(host);
    log.info(
      isPushed
        ? `Done! Pushed machine data migration for ${host}.`
        : `No local data found (${syncedProviders()
            .map((provider) => provider.descriptor.label)
            .join(' or ')}).`,
    );
    return freshData;
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
      isPushed = pushMachineData(host);
    }
    log.info(isPushed ? pushedMessage(host, syncedDays) : NO_CHANGES_MESSAGE);
    return freshData;
  }

  if (isDryRun) {
    const action = existingDays === null ? 'create' : 'update';
    log.info(
      `Dry run: would ${action} data/${host}.json (${String(syncedDays)} days). No changes written.`,
    );
    return freshData;
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(dataFilePath, JSON.stringify(outgoingData, null, 2), 'utf8');
  removePendingMachineFile(host);

  log.info(commitAndPush(host) ? pushedMessage(host, syncedDays) : NO_CHANGES_MESSAGE);
  return freshData;
}

export async function syncCommand(options: SyncDataOptions = {}): Promise<void> {
  await syncData(options);
}
