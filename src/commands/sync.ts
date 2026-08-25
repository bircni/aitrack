import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, resolveMachineId } from '../config.js';
import { buildMachineData, mergePersistedDays, readLocalProviderMaps } from '../data/localData.js';
import { REPO_NOT_CLONED_MESSAGE } from '../data/messages.js';
import type { MachineFile } from '../data/types.js';
import { parseMachineFile } from '../data/validate.js';
import {
  commitAndPush,
  hasMachineDataChanges,
  isCloned,
  LOCAL_REPO,
  pull,
  pushPendingCommits,
  removePendingMachineFile,
} from '../git.js';
import { machineDataFilename } from '../machineId.js';
import { log } from '../output.js';
import { reportFallbackPricing } from '../pricing/fallback.js';

export interface SyncDataOptions {
  quiet?: boolean;
  dryRun?: boolean;
}

const NO_CHANGES_MESSAGE = 'No changes to push — data is already up to date.';

function pushedMessage(host: string, syncedDays: number): string {
  return `Done! Pushed data/${host}.json (${String(syncedDays)} days)`;
}

/** Progress reporting, silenced by `quiet` — the daemon syncs on every tick. */
function progressLogger(isQuiet: boolean): (message: string) => void {
  if (isQuiet) return () => undefined;
  return (message) => {
    log.info(message);
  };
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
 * logs so a caller that also needs it (the daemon renders right after syncing)
 * can reuse it instead of parsing the whole JSONL corpus a second time.
 */
export async function syncData(options: SyncDataOptions = {}): Promise<MachineFile> {
  try {
    return await pushLocalUsage(options);
  } finally {
    // Fallback hits accumulate while the logs are read, so they exist however
    // the push turns out. Reporting them only after a successful push hid the
    // warning from every already-up-to-date run, and left the set uncleared —
    // so a long-lived daemon carried one tick's models into the next.
    reportFallbackPricing();
  }
}

async function pushLocalUsage(options: SyncDataOptions): Promise<MachineFile> {
  const config = loadConfig();
  const isDryRun = Boolean(options.dryRun);
  const log = progressLogger(Boolean(options.quiet));

  if (!isCloned()) {
    throw new Error(REPO_NOT_CLONED_MESSAGE);
  }

  if (!isDryRun) {
    log('Pulling latest from remote...');
    pull();
  }

  const host = resolveMachineId(config);
  const dataDir = join(LOCAL_REPO, 'data');
  const dataFilePath = join(dataDir, machineDataFilename(host));

  // Cursor usage is loaded locally by report/display commands; it is never written to git.
  log('Reading local data...');
  const { claude_code: claudeData, codex: codexData } = await readLocalProviderMaps();

  const freshData = buildMachineData(host, { claude_code: claudeData, codex: codexData });
  const totalDays = new Set([...claudeData.keys(), ...codexData.keys()]).size;

  if (totalDays === 0) {
    const isPushed = !isDryRun && pushMachineData(host);
    log(
      isPushed
        ? `Done! Pushed machine data migration for ${host}.`
        : 'No local data found (Claude Code or Codex).',
    );
    return freshData;
  }

  const sources: string[] = [];
  if (claudeData.size > 0) sources.push(`Claude Code (${String(claudeData.size)} days)`);
  if (codexData.size > 0) sources.push(`Codex (${String(codexData.size)} days)`);
  log(`Found: ${sources.join(', ')}`);

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

  // parseMachineFile also returns null for a file that exists but is invalid.
  // Merging against null there would silently replace the synced history with
  // whatever the local logs still reach and push the loss.
  let existingDays: MachineFile['days'] | null = null;
  if (raw !== null) {
    const existing = parseMachineFile(raw, dataFilePath);
    if (!existing) {
      throw new Error(
        `Refusing to overwrite invalid data/${machineDataFilename(host)} (see the warning above).\n` +
          "  Run: npx aitrack recompute-costs   (rebuilds this machine's file from the local logs)",
      );
    }
    existingDays = existing.days;
  }

  // Keep days the local logs no longer cover — see mergePersistedDays.
  const outgoingDays = mergePersistedDays(existingDays, freshData.days);
  const outgoingData: MachineFile = { ...freshData, days: outgoingDays };
  const syncedDays = Object.keys(outgoingDays).length;
  // Normalize the persisted side through the same ordering so a file that is
  // already up to date does not look changed purely because of key order.
  const normalizedExisting = existingDays === null ? null : mergePersistedDays(existingDays, {});

  if (JSON.stringify(normalizedExisting) === JSON.stringify(outgoingDays)) {
    let isPushed = false;
    if (!isDryRun) {
      removePendingMachineFile(host);
      isPushed = pushMachineData(host);
    }
    log(isPushed ? pushedMessage(host, syncedDays) : NO_CHANGES_MESSAGE);
    return freshData;
  }

  if (isDryRun) {
    const action = existingDays === null ? 'create' : 'update';
    log(
      `Dry run: would ${action} data/${host}.json (${String(syncedDays)} days). No changes written.`,
    );
    return freshData;
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(dataFilePath, JSON.stringify(outgoingData, null, 2), 'utf8');
  removePendingMachineFile(host);

  log(commitAndPush(host) ? pushedMessage(host, syncedDays) : NO_CHANGES_MESSAGE);
  return freshData;
}

export async function syncCommand(options: SyncDataOptions = {}): Promise<void> {
  await syncData(options);
}
