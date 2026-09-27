import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  loadConfig,
  localMachineId,
  resolveMachineId,
  saveConfig,
  tryLoadConfig,
} from 'aitrack-lib/config';
import {
  buildMachineData,
  mergePersistedDays,
  readLocalProviderMaps,
} from 'aitrack-lib/data/localData';
import { checkRawMachineFile } from 'aitrack-lib/data/validate';
import {
  cloneRepo,
  commitAndPush,
  hasMachineDataChanges,
  isCloned,
  listDataFiles,
  LOCAL_REPO,
  pull,
  pushPendingCommits,
  readDataFile,
  removePendingMachineFile,
  writeMachineFile,
} from 'aitrack-lib/git';
import { machineDataFilename } from 'aitrack-lib/machineId';

export interface SyncStatus {
  configured: boolean;
  cloned: boolean;
  machineId: string | null;
  repoUrl: string | null;
  dirty: boolean;
}

export interface MachineSummary {
  id: string;
  timezone: string | null;
  lastUpdated: string | null;
  days: number;
}

export function syncStatus(): SyncStatus {
  try {
    const config = loadConfig();
    const machineId = resolveMachineId(config);
    return {
      configured: true,
      cloned: isCloned(),
      machineId,
      repoUrl: config.repoUrl,
      dirty: isCloned() && hasMachineDataChanges(machineId),
    };
  } catch {
    return { configured: false, cloned: isCloned(), machineId: null, repoUrl: null, dirty: false };
  }
}

export function machines(): MachineSummary[] {
  if (!isCloned()) return [];
  const summaries: MachineSummary[] = [];
  for (const file of listDataFiles()) {
    const parsed = readDataFile(file);
    if (parsed === null) continue;
    summaries.push({
      id: parsed.hostname,
      timezone: parsed.timezone,
      lastUpdated: parsed.lastUpdated,
      days: Object.keys(parsed.days).length,
    });
  }
  return summaries;
}

export interface PushPreview {
  ok: boolean;
  message: string;
  file: string | null;
  days: number;
}

/**
 * Describes the file a push would write. It does not pull, commit, or push.
 */
export async function previewPush(): Promise<PushPreview> {
  const status = syncStatus();
  if (!status.cloned || status.machineId === null) {
    return {
      ok: false,
      message: 'No data repo yet. The app is fully useful without one.',
      file: null,
      days: 0,
    };
  }
  const maps = await readLocalProviderMaps();
  const fresh = buildMachineData(status.machineId, maps);
  const file = `data/${machineDataFilename(status.machineId)}`;
  const days = Object.keys(fresh.days).length;
  return {
    ok: true,
    file,
    days,
    message: `${file} would be updated with ${String(days)} days of Claude Code and Codex totals, then pushed. Cursor tokens stay on this machine.`,
  };
}

/**
 * Clone a data repo the user named. Requires confirm: 'clone'. Does not replace
 * an existing config that points somewhere else.
 */
export function connectDataRepo(
  confirm: string,
  repoUrl: string,
): { ok: boolean; message: string } {
  if (confirm !== 'clone') return { ok: false, message: 'Clone was not confirmed.' };
  const url = repoUrl.trim();
  if (url === '') return { ok: false, message: 'A git remote URL is required.' };
  const existing = tryLoadConfig();
  if (existing !== null && existing.repoUrl !== url) {
    return {
      ok: false,
      message: 'A data repo is already configured. Change it with aitrack init.',
    };
  }
  if (existing?.repoUrl === url && isCloned()) {
    return { ok: true, message: 'Already connected.' };
  }
  try {
    if (!isCloned()) {
      mkdirSync(dirname(LOCAL_REPO), { recursive: true });
      cloneRepo(url);
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Clone failed.' };
  }
  const machineId = existing?.machineId ?? localMachineId();
  const config =
    existing === null ? { repoUrl: url, machineId } : { ...existing, repoUrl: url, machineId };
  saveConfig(config);
  return { ok: true, message: `Connected ${url} as ${machineId}.` };
}

/**
 * The only networked write in the app. The caller must pass confirm: 'push'.
 */
export async function pushDataRepo(confirm: string): Promise<{ ok: boolean; message: string }> {
  if (confirm !== 'push') return { ok: false, message: 'Push was not confirmed.' };
  const status = syncStatus();
  if (!status.cloned || status.machineId === null) {
    return {
      ok: false,
      message: 'No data repo yet. Run aitrack init, or connect one from Settings.',
    };
  }
  const host = status.machineId;
  pull();
  const maps = await readLocalProviderMaps();
  const fresh = buildMachineData(host, maps);
  const dataFilePath = join(LOCAL_REPO, 'data', machineDataFilename(host));
  let existingDays = null;
  try {
    const raw = readFileSync(dataFilePath, 'utf8');
    const checked = checkRawMachineFile(raw, dataFilePath);
    if (!checked.machine)
      return { ok: false, message: 'The synced file is invalid. Run aitrack recompute-costs.' };
    existingDays = checked.machine.days;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT') return { ok: false, message: 'Could not read the synced file.' };
  }
  const outgoing = { ...fresh, days: mergePersistedDays(existingDays, fresh.days) };
  writeMachineFile(dataFilePath, outgoing);
  removePendingMachineFile(host);
  const pushed = commitAndPush(host) || pushPendingCommits();
  return {
    ok: pushed,
    message: pushed ? `Pushed data/${host}.json.` : 'Nothing new to push.',
  };
}
