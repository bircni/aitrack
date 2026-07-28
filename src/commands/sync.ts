import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, resolveMachineId } from '../config.js';
import { buildMachineData, mergePersistedDays, readLocalProviderMaps } from '../data/localData.js';
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
import { consumeClaudeFallbackHits } from '../pricing/claude.js';
import { consumeCodexFallbackHits } from '../pricing/codex.js';

export interface SyncDataOptions {
  quiet?: boolean;
  dryRun?: boolean;
}

export async function syncData(options: SyncDataOptions = {}): Promise<void> {
  const config = loadConfig();
  const isQuiet = Boolean(options.quiet);
  const isDryRun = Boolean(options.dryRun);

  if (!isCloned()) {
    throw new Error('Repo not cloned. Run: npx aitrack init');
  }

  if (!isQuiet && !isDryRun) {
    console.log('Pulling latest from remote...');
  }
  if (!isDryRun) {
    pull();
  }

  const host = resolveMachineId(config);
  const dataDir = join(LOCAL_REPO, 'data');
  const dataFilePath = join(dataDir, machineDataFilename(host));

  // Cursor usage is loaded locally by report/display commands; it is never written to git.
  if (!isQuiet) {
    console.log('Reading local data...');
  }
  const { claude_code: claudeData, codex: codexData } = await readLocalProviderMaps();

  const totalDays = new Set([...claudeData.keys(), ...codexData.keys()]).size;

  if (totalDays === 0) {
    const isPushed =
      !isDryRun && ((hasMachineDataChanges(host) && commitAndPush(host)) || pushPendingCommits());
    if (!isQuiet) {
      console.log(
        isPushed
          ? `Done! Pushed machine data migration for ${host}.`
          : 'No local data found (Claude Code or Codex).',
      );
    }
    return;
  }

  if (!isQuiet) {
    const sources: string[] = [];
    if (claudeData.size > 0) sources.push(`Claude Code (${claudeData.size} days)`);
    if (codexData.size > 0) sources.push(`Codex (${codexData.size} days)`);
    console.log(`Found: ${sources.join(', ')}`);
  }

  const freshData = buildMachineData(host, { claude_code: claudeData, codex: codexData });

  // Only write if the usage data changed — avoids a spurious commit on every run
  // (lastUpdated would otherwise always make the file dirty).
  let existingDays: MachineFile['days'] | null = null;
  try {
    const raw = readFileSync(dataFilePath, 'utf8');
    existingDays = parseMachineFile(raw, dataFilePath)?.days ?? null;
  } catch {
    /* file doesn't exist yet */
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
      // A machineId change can leave a matching target file as a pending git
      // rename. Give it the same commit/push path as a content update.
      // pushPendingCommits covers a commit whose earlier push failed: the tree
      // is clean again, so nothing else here would notice it never landed.
      isPushed = (hasMachineDataChanges(host) && commitAndPush(host)) || pushPendingCommits();
    }
    if (!isQuiet) {
      console.log(
        isPushed
          ? `Done! Pushed data/${host}.json (${String(syncedDays)} days)`
          : 'No changes to push — data is already up to date.',
      );
    }
    return;
  }

  if (isDryRun) {
    if (!isQuiet) {
      const action = existingDays === null ? 'create' : 'update';
      console.log(
        `Dry run: would ${action} data/${host}.json (${String(syncedDays)} days). No changes written.`,
      );
    }
    return;
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(dataFilePath, JSON.stringify(outgoingData, null, 2), 'utf8');
  removePendingMachineFile(host);

  const isPushed = commitAndPush(host);
  if (!isPushed) {
    if (!isQuiet) {
      console.log('No changes to push — data is already up to date.');
    }
    return;
  }
  if (!isQuiet) {
    console.log(`Done! Pushed data/${host}.json (${syncedDays} days)`);
  }

  const fb = [...consumeClaudeFallbackHits(), ...consumeCodexFallbackHits()];
  if (fb.length > 0) {
    console.warn(
      `\nWarning: priced via family fallback (no exact pricing in src/pricing/): ${fb.join(', ')}`,
    );
    console.warn(
      '  These models may be wrong — please update src/pricing/ with the correct rates.',
    );
  }
}

export async function syncCommand(options: SyncDataOptions = {}): Promise<void> {
  await syncData(options);
}
