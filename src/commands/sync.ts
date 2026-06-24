import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, resolveMachineId } from '../config.js';
import { buildMachineData, readLocalProviderMaps } from '../data/localData.js';
import type { MachineFile } from '../data/types.js';
import { commitAndPush, isCloned, LOCAL_REPO, pull, removePendingMachineFile } from '../git.js';
import { consumeClaudeFallbackHits } from '../pricing/claude.js';
import { consumeCodexFallbackHits } from '../pricing/codex.js';

export interface SyncDataOptions {
  quiet?: boolean;
}

export async function syncData(options: SyncDataOptions = {}): Promise<void> {
  const config = loadConfig();
  const isQuiet = Boolean(options.quiet);

  if (!isCloned()) {
    throw new Error('Repo not cloned. Run: npx aitrack init');
  }

  if (!isQuiet) {
    console.log('Pulling latest from remote...');
  }
  pull();

  // Cursor usage is merged at `show` time only (local CSV export); it is never written to git.
  if (!isQuiet) {
    console.log('Reading local data...');
  }
  const { claude_code: claudeData, codex: codexData } = await readLocalProviderMaps();

  const totalDays = new Set([...claudeData.keys(), ...codexData.keys()]).size;

  if (totalDays === 0) {
    if (!isQuiet) {
      console.log('No local data found (Claude Code or Codex).');
    }
    return;
  }

  if (!isQuiet) {
    const sources: string[] = [];
    if (claudeData.size > 0) sources.push(`Claude Code (${claudeData.size} days)`);
    if (codexData.size > 0) sources.push(`Codex (${codexData.size} days)`);
    console.log(`Found: ${sources.join(', ')}`);
  }

  const host = resolveMachineId(config);
  const dataDir = join(LOCAL_REPO, 'data');
  mkdirSync(dataDir, { recursive: true });

  const freshData = buildMachineData(host, { claude_code: claudeData, codex: codexData });
  const dataFilePath = join(dataDir, `${host}.json`);

  // Only write if the usage data changed — avoids a spurious commit on every run
  // (lastUpdated would otherwise always make the file dirty).
  let existingDays: MachineFile['days'] | null = null;
  try {
    const raw = readFileSync(dataFilePath, 'utf8');
    existingDays = (JSON.parse(raw) as MachineFile).days;
  } catch {
    /* file doesn't exist yet */
  }

  if (JSON.stringify(existingDays) === JSON.stringify(freshData.days)) {
    if (!isQuiet) {
      console.log('No changes to push — data is already up to date.');
    }
    removePendingMachineFile(host);
    return;
  }

  writeFileSync(dataFilePath, JSON.stringify(freshData, null, 2), 'utf8');
  removePendingMachineFile(host);

  const isPushed = commitAndPush(host);
  if (!isPushed) {
    if (!isQuiet) {
      console.log('No changes to push — data is already up to date.');
    }
    return;
  }
  if (!isQuiet) {
    console.log(`Done! Pushed data/${host}.json (${totalDays} days)`);
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

export async function syncCommand(): Promise<void> {
  await syncData();
}
